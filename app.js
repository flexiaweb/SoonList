import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
    getFirestore,
    doc,
    getDoc,
    setDoc,
    updateDoc,
    deleteDoc,
    collection,
    getDocs,
    onSnapshot
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";

const firebaseConfig = {
    apiKey: "AIzaSyBmnmUSfas4TgK6DOVetRYMbryxWa1LSMA",
    authDomain: "soonlist-8949d.firebaseapp.com",
    projectId: "soonlist-8949d",
    storageBucket: "soonlist-8949d.firebasestorage.app",
    messagingSenderId: "450865995870",
    appId: "1:450865995870:web:9963cacb8b79da302314cf"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app);

function ensureAuth() {
    return new Promise((resolve, reject) => {
        if (auth.currentUser) {
            resolve(auth.currentUser);
            return;
        }
        const unsub = onAuthStateChanged(auth, async (user) => {
            unsub();
            if (user) {
                resolve(user);
            } else {
                try {
                    const cred = await signInAnonymously(auth);
                    resolve(cred.user);
                } catch (err) {
                    reject(err);
                }
            }
        });
    });
}

/**
 * CAPA DE DATOS CON FIRESTORE (imágenes comprimidas guardadas en el documento del grupo)
 */
const StorageService = {
    SESSION_KEY: 'wishgroup_firebase_session_v1',
    SAVED_GROUPS_KEY: 'wishgroup_saved_group_ids_v1',
    LOCAL_CODES_KEY: 'wishgroup_my_codes_v1',

    _getSavedGroupIds() {
        const raw = localStorage.getItem(this.SAVED_GROUPS_KEY);
        return raw ? JSON.parse(raw) : [];
    },

    _rememberGroupId(groupId) {
        const ids = this._getSavedGroupIds();
        if (!ids.includes(groupId)) {
            ids.unshift(groupId);
            localStorage.setItem(this.SAVED_GROUPS_KEY, JSON.stringify(ids.slice(0, 20)));
        }
    },

    _forgetGroupId(groupId) {
        const ids = this._getSavedGroupIds().filter(id => id !== groupId);
        localStorage.setItem(this.SAVED_GROUPS_KEY, JSON.stringify(ids));
    },

    _saveOwnCodeLocally(groupId, memberId, code) {
        const raw = localStorage.getItem(this.LOCAL_CODES_KEY);
        const map = raw ? JSON.parse(raw) : {};
        map[`${groupId}_${memberId}`] = code;
        localStorage.setItem(this.LOCAL_CODES_KEY, JSON.stringify(map));
    },

    getOwnCodeLocally(groupId, memberId) {
        const raw = localStorage.getItem(this.LOCAL_CODES_KEY);
        const map = raw ? JSON.parse(raw) : {};
        return map[`${groupId}_${memberId}`] || '••••••';
    },

    generateGenericCode() {
        return String(Math.floor(100000 + Math.random() * 900000));
    },

    async createGroup(groupName, creatorName) {
        const user = await ensureAuth();
        const groupId = 'grp_' + Math.random().toString(36).substring(2, 10);
        const memberId = 'mem_' + Math.random().toString(36).substring(2, 10);
        const secretCode = this.generateGenericCode();

        const groupDoc = {
            id: groupId,
            name: groupName,
            createdBy: memberId,
            createdByUid: user.uid,
            createdAt: Date.now(),
            members: [
                { id: memberId, name: creatorName, isCreator: true }
            ],
            wishes: [],
            secretNotices: []
        };

        await setDoc(doc(db, 'groups', groupId), groupDoc);
        await setDoc(doc(db, 'groups', groupId, 'memberSecrets', memberId), {
            memberId,
            code: secretCode,
            ownerUid: user.uid,
            createdAt: Date.now()
        });

        this._rememberGroupId(groupId);
        this._saveOwnCodeLocally(groupId, memberId, secretCode);
        this.setSession(groupId, memberId);
        return { groupId, memberId, secretCode };
    },

    async updateGroupName(groupId, newName) {
        await ensureAuth();
        await updateDoc(doc(db, 'groups', groupId), { name: newName });
    },

    async deleteGroup(groupId, requesterId) {
        await ensureAuth();
        const groupRef = doc(db, 'groups', groupId);
        const snap = await getDoc(groupRef);
        if (!snap.exists()) return false;

        const group = snap.data();
        const requester = (group.members || []).find(m => m.id === requesterId);
        const isCreator = group.createdBy === requesterId || (requester && requester.isCreator);
        if (!isCreator) return false;

        const secretsSnap = await getDocs(collection(db, 'groups', groupId, 'memberSecrets'));
        for (const secretDoc of secretsSnap.docs) {
            try {
                await deleteDoc(secretDoc.ref);
            } catch (_) { /* ignorar si las reglas lo bloquean */ }
        }

        await deleteDoc(groupRef);
        this._forgetGroupId(groupId);

        const session = this.getSession();
        if (session && session.groupId === groupId) {
            localStorage.removeItem(this.SESSION_KEY);
        }
        return true;
    },

    async leaveGroup(groupId, memberId) {
        await ensureAuth();
        const groupRef = doc(db, 'groups', groupId);
        const snap = await getDoc(groupRef);
        if (!snap.exists()) return;

        const group = snap.data();
        const updatedMembers = (group.members || []).filter(m => m.id !== memberId);
        const updatedWishes = (group.wishes || [])
            .filter(w => w.ownerId !== memberId)
            .map(w => w.claimedBy === memberId ? { ...w, claimedBy: null, purchased: false } : w);
        const updatedNotices = (group.secretNotices || []).filter(n => n.recipientId !== memberId);

        await updateDoc(groupRef, {
            members: updatedMembers,
            wishes: updatedWishes,
            secretNotices: updatedNotices
        });

        try {
            await deleteDoc(doc(db, 'groups', groupId, 'memberSecrets', memberId));
        } catch (_) { /* ignorar */ }

        this._forgetGroupId(groupId);
        const session = this.getSession();
        if (session && session.groupId === groupId) {
            localStorage.removeItem(this.SESSION_KEY);
        }
    },

    async getGroup(groupId) {
        await ensureAuth();
        const snap = await getDoc(doc(db, 'groups', groupId));
        if (!snap.exists()) return null;
        this._rememberGroupId(groupId);
        return snap.data();
    },

    subscribeGroup(groupId, onUpdate) {
        return onSnapshot(doc(db, 'groups', groupId), (snap) => {
            if (snap.exists()) {
                this._rememberGroupId(groupId);
                onUpdate(snap.data());
            } else {
                onUpdate(null);
            }
        });
    },

    async getAllGroups() {
        await ensureAuth();
        const ids = this._getSavedGroupIds();
        const results = [];
        for (const id of ids) {
            const snap = await getDoc(doc(db, 'groups', id));
            if (snap.exists()) {
                results.push(snap.data());
            }
        }
        return results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    },

    async addMember(groupId, name) {
        const user = await ensureAuth();
        const groupRef = doc(db, 'groups', groupId);
        const snap = await getDoc(groupRef);
        if (!snap.exists()) throw new Error('Grupo no encontrado');

        const group = snap.data();
        const memberId = 'mem_' + Math.random().toString(36).substring(2, 10);
        const secretCode = this.generateGenericCode();

        const updatedMembers = [
            ...(group.members || []),
            { id: memberId, name, isCreator: false }
        ];

        await updateDoc(groupRef, { members: updatedMembers });
        await setDoc(doc(db, 'groups', groupId, 'memberSecrets', memberId), {
            memberId,
            code: secretCode,
            ownerUid: user.uid,
            createdAt: Date.now()
        });

        this._rememberGroupId(groupId);
        this._saveOwnCodeLocally(groupId, memberId, secretCode);
        this.setSession(groupId, memberId);
        return { memberId, secretCode };
    },

    async verifyMemberCode(groupId, memberId, inputCode) {
        await ensureAuth();
        try {
            const verifyFn = httpsCallable(functions, 'verifyMemberCode');
            const res = await verifyFn({ groupId, memberId, code: inputCode });
            if (res.data && res.data.valid) {
                this._saveOwnCodeLocally(groupId, memberId, inputCode);
                return true;
            }
            return false;
        } catch (err) {
            console.error('Error verificando código en Cloud Function:', err);
            return false;
        }
    },

    async addWish(groupId, wishData) {
        await ensureAuth();
        const groupRef = doc(db, 'groups', groupId);
        const snap = await getDoc(groupRef);
        if (!snap.exists()) return null;

        const group = snap.data();
        const wishId = 'wsh_' + Math.random().toString(36).substring(2, 10);

        const newWish = {
            id: wishId,
            ownerId: wishData.ownerId,
            title: wishData.title,
            url: wishData.url || '',
            note: wishData.note || '',
            imageDataUrl: wishData.imageDataUrl || null,
            claimedBy: null,
            purchased: false,
            createdAt: Date.now()
        };

        await updateDoc(groupRef, {
            wishes: [...(group.wishes || []), newWish]
        });

        return newWish;
    },

    async deleteWish(groupId, wishId) {
        await ensureAuth();
        const groupRef = doc(db, 'groups', groupId);
        const snap = await getDoc(groupRef);
        if (!snap.exists()) return;

        const group = snap.data();
        const wishes = group.wishes || [];
        const targetWish = wishes.find(w => w.id === wishId);
        const secretNotices = [...(group.secretNotices || [])];

        if (targetWish && targetWish.claimedBy) {
            secretNotices.push({
                id: 'ntc_' + Math.random().toString(36).substring(2, 10),
                recipientId: targetWish.claimedBy,
                wishTitle: targetWish.title,
                createdAt: Date.now()
            });
        }

        await updateDoc(groupRef, {
            wishes: wishes.filter(w => w.id !== wishId),
            secretNotices
        });
    },

    async dismissNotice(groupId, noticeId) {
        await ensureAuth();
        const groupRef = doc(db, 'groups', groupId);
        const snap = await getDoc(groupRef);
        if (!snap.exists()) return;

        const group = snap.data();
        const secretNotices = (group.secretNotices || []).filter(n => n.id !== noticeId);
        await updateDoc(groupRef, { secretNotices });
    },

    async toggleClaimWish(groupId, wishId, claimerId) {
        await ensureAuth();
        const groupRef = doc(db, 'groups', groupId);
        const snap = await getDoc(groupRef);
        if (!snap.exists()) return;

        const group = snap.data();
        const wishes = (group.wishes || []).map(w => {
            if (w.id !== wishId) return w;
            if (w.claimedBy === null) {
                return { ...w, claimedBy: claimerId, purchased: false };
            }
            if (w.claimedBy === claimerId) {
                return { ...w, claimedBy: null, purchased: false };
            }
            return w;
        });

        await updateDoc(groupRef, { wishes });
    },

    async togglePurchased(groupId, wishId) {
        await ensureAuth();
        const groupRef = doc(db, 'groups', groupId);
        const snap = await getDoc(groupRef);
        if (!snap.exists()) return;

        const group = snap.data();
        const wishes = (group.wishes || []).map(w =>
            w.id === wishId ? { ...w, purchased: !w.purchased } : w
        );

        await updateDoc(groupRef, { wishes });
    },

    setSession(groupId, memberId) {
        localStorage.setItem(this.SESSION_KEY, JSON.stringify({ groupId, memberId }));
    },

    getSession() {
        const raw = localStorage.getItem(this.SESSION_KEY);
        return raw ? JSON.parse(raw) : null;
    },

    clearMemberSession(groupId) {
        localStorage.setItem(this.SESSION_KEY, JSON.stringify({ groupId, memberId: null }));
    }
};

/**
 * CONTROLADOR DE INTERFAZ (WishApp)
 */
const WishApp = {
    state: {
        groupId: null,
        memberId: null,
        group: null,
        pendingImageDataUrl: null,
        activeNoticeId: null,
        pendingConfirmCallback: null,
        unsubscribeGroup: null,
        noticesPopupShownForSession: false
    },

    refreshIcons() {
        if (window.lucide) {
            window.lucide.createIcons();
        }
    },

    async init() {
        await ensureAuth();
        this.bindEvents();
        await this.renderSavedGroupsOnboarding();
        this.refreshIcons();

        const params = new URLSearchParams(window.location.search);
        const urlGroupId = params.get('g');
        const session = StorageService.getSession();
        const targetGroupId = urlGroupId || (session && session.groupId);

        if (targetGroupId) {
            const group = await StorageService.getGroup(targetGroupId);
            if (group) {
                await this.loadGroupContext(group, session);
                return;
            }
        }

        this.switchView('view-onboarding');
    },

    _attachGroupListener(groupId) {
        if (this.state.unsubscribeGroup) {
            this.state.unsubscribeGroup();
            this.state.unsubscribeGroup = null;
        }
        this.state.unsubscribeGroup = StorageService.subscribeGroup(groupId, async (updatedGroup) => {
            if (!updatedGroup) {
                await this.returnToOnboarding();
                return;
            }
            this.state.group = updatedGroup;
            if (this.state.memberId) {
                const stillMember = (updatedGroup.members || []).some(m => m.id === this.state.memberId);
                if (!stillMember) {
                    StorageService.clearMemberSession(groupId);
                    this.state.memberId = null;
                    this.showAuthView();
                    return;
                }
                this.renderCurrentMainView();
            } else {
                this.showAuthView();
            }
        });
    },

    async loadGroupContext(group, session = null) {
        this.state.groupId = group.id;
        this.state.group = group;
        this.state.noticesPopupShownForSession = false;
        this.updateUrlParam(group.id);
        this._attachGroupListener(group.id);

        const activeSession = session || StorageService.getSession();
        if (activeSession && activeSession.groupId === group.id && activeSession.memberId) {
            const exists = (group.members || []).some(m => m.id === activeSession.memberId);
            if (exists) {
                this.state.memberId = activeSession.memberId;
                await this.enterMainApp({ showNoticesPopup: true });
                return;
            }
        }

        this.state.memberId = null;
        this.showAuthView();
    },

    async returnToOnboarding() {
        if (this.state.unsubscribeGroup) {
            this.state.unsubscribeGroup();
            this.state.unsubscribeGroup = null;
        }
        this.state.groupId = null;
        this.state.memberId = null;
        this.state.group = null;
        const url = new URL(window.location);
        url.searchParams.delete('g');
        window.history.pushState({}, '', url);
        await this.renderSavedGroupsOnboarding();
        this.switchView('view-onboarding');
    },

    async renderSavedGroupsOnboarding() {
        const groups = await StorageService.getAllGroups();
        const box = document.getElementById('saved-groups-onboarding');
        const list = document.getElementById('onboarding-groups-list');

        if (!groups.length) {
            box.classList.add('hidden');
            return;
        }

        box.classList.remove('hidden');
        list.innerHTML = '';
        groups.forEach(g => {
            const row = document.createElement('div');
            row.className = 'group-item-row';
            row.innerHTML = `
                <div>
                    <div class="group-item-title">${g.name}</div>
                    <div class="group-item-meta">${(g.members || []).length} miembros</div>
                </div>
                <i data-lucide="chevron-right"></i>
            `;
            row.addEventListener('click', () => this.loadGroupContext(g));
            list.appendChild(row);
        });
    },

    openImageLightbox(imageSrc, caption = '') {
        if (!imageSrc) return;
        document.getElementById('lightbox-full-image').src = imageSrc;
        document.getElementById('lightbox-caption').textContent = caption;
        this.refreshIcons();
        document.getElementById('modal-image-lightbox').classList.remove('hidden');
    },

    closeImageLightbox() {
        document.getElementById('lightbox-full-image').src = '';
        document.getElementById('modal-image-lightbox').classList.add('hidden');
    },

    openWishDetailModal(wishId) {
        const wish = (this.state.group.wishes || []).find(w => w.id === wishId);
        if (!wish) return;

        const owner = (this.state.group.members || []).find(m => m.id === wish.ownerId);
        const imgBox = document.getElementById('detail-image-box');
        const imgEl = document.getElementById('detail-wish-image');

        if (wish.imageDataUrl) {
            imgEl.src = wish.imageDataUrl;
            imgEl.alt = wish.title;
            imgBox.classList.remove('hidden');
            imgBox.onclick = () => this.openImageLightbox(wish.imageDataUrl, wish.title);
            document.getElementById('btn-zoom-detail-image').onclick = (e) => {
                e.stopPropagation();
                this.openImageLightbox(wish.imageDataUrl, wish.title);
            };
        } else {
            imgEl.src = '';
            imgBox.classList.add('hidden');
            imgBox.onclick = null;
        }

        document.getElementById('detail-wish-recipient').textContent =
            `Para ${owner ? owner.name : 'Miembro'}`;
        document.getElementById('detail-wish-title').textContent = wish.title;

        const noteEl = document.getElementById('detail-wish-note');
        if (wish.note) {
            noteEl.textContent = wish.note;
            noteEl.classList.remove('hidden');
        } else {
            noteEl.textContent = '';
            noteEl.classList.add('hidden');
        }

        const linkEl = document.getElementById('detail-wish-url');
        if (wish.url) {
            linkEl.href = wish.url;
            linkEl.classList.remove('hidden');
        } else {
            linkEl.href = '#';
            linkEl.classList.add('hidden');
        }

        const actionsEl = document.getElementById('detail-wish-actions');
        actionsEl.innerHTML = `
            <button type="button" class="btn ${wish.purchased ? 'btn-success' : 'btn-secondary'}" id="detail-btn-purchased">
                <i data-lucide="${wish.purchased ? 'check-circle-2' : 'circle'}"></i>
                <span>${wish.purchased ? 'Comprado' : 'Marcar comprado'}</span>
            </button>
            <button type="button" class="btn btn-soft-danger" id="detail-btn-unclaim">Soltar</button>
        `;

        document.getElementById('detail-btn-purchased').addEventListener('click', async () => {
            await StorageService.togglePurchased(this.state.groupId, wish.id);
            this.openWishDetailModal(wish.id);
        });

        document.getElementById('detail-btn-unclaim').addEventListener('click', () => {
            this.handleReleaseClaim(wish.id, {
                onReleased: () => {
                    document.getElementById('modal-wish-detail').classList.add('hidden');
                }
            });
        });

        this.refreshIcons();
        document.getElementById('modal-wish-detail').classList.remove('hidden');
    },

    openConfirmModal({ title, desc, onConfirm }) {
        document.getElementById('confirm-modal-title').textContent = title;
        document.getElementById('confirm-modal-desc').textContent = desc;
        this.state.pendingConfirmCallback = onConfirm;
        this.refreshIcons();
        document.getElementById('modal-confirm').classList.remove('hidden');
    },

    openWelcomeCodePopup(memberName, code) {
        document.getElementById('welcome-member-name').textContent = memberName;
        document.getElementById('welcome-secret-code').textContent = code;
        const copyBtn = document.getElementById('btn-copy-welcome-code');
        copyBtn.innerHTML = `<i data-lucide="copy"></i><span>Copiar código</span>`;
        this.refreshIcons();
        document.getElementById('modal-welcome-code').classList.remove('hidden');
    },

    maybeOpenNextSecretNoticePopup() {
        if (this.state.noticesPopupShownForSession) return;
        const notices = (this.state.group.secretNotices || []).filter(
            n => n.recipientId === this.state.memberId
        );
        if (!notices.length) return;

        this.state.noticesPopupShownForSession = true;
        const firstNotice = notices[0];
        this.state.activeNoticeId = firstNotice.id;
        document.getElementById('popup-notice-message').textContent =
            `Aviso discreto: se ha eliminado el deseo "${firstNotice.wishTitle}" que tenías elegido.`;
        this.refreshIcons();
        document.getElementById('modal-secret-notice').classList.remove('hidden');
    },

    bindEvents() {
        document.getElementById('btn-close-lightbox').addEventListener('click', () => this.closeImageLightbox());
        document.getElementById('modal-image-lightbox').addEventListener('click', (e) => {
            if (e.target.id === 'modal-image-lightbox') this.closeImageLightbox();
        });

        document.getElementById('btn-cancel-confirm').addEventListener('click', () => {
            this.state.pendingConfirmCallback = null;
            document.getElementById('modal-confirm').classList.add('hidden');
        });

        document.getElementById('btn-accept-confirm').addEventListener('click', async () => {
            const cb = this.state.pendingConfirmCallback;
            this.state.pendingConfirmCallback = null;
            document.getElementById('modal-confirm').classList.add('hidden');
            if (typeof cb === 'function') await cb();
        });

        document.getElementById('btn-copy-welcome-code').addEventListener('click', () => {
            const code = document.getElementById('welcome-secret-code').textContent;
            navigator.clipboard.writeText(code);
            const btn = document.getElementById('btn-copy-welcome-code');
            btn.innerHTML = `<i data-lucide="check"></i><span>Copiado</span>`;
            this.refreshIcons();
            setTimeout(() => {
                btn.innerHTML = `<i data-lucide="copy"></i><span>Copiar código</span>`;
                this.refreshIcons();
            }, 2000);
        });

        document.getElementById('btn-confirm-secret-notice').addEventListener('click', async () => {
            const noticeId = this.state.activeNoticeId;
            this.state.activeNoticeId = null;
            document.getElementById('modal-secret-notice').classList.add('hidden');
            if (noticeId) {
                await StorageService.dismissNotice(this.state.groupId, noticeId);
                this.state.noticesPopupShownForSession = false;
                this.maybeOpenNextSecretNoticePopup();
            }
        });

        document.getElementById('form-create-group').addEventListener('submit', async (e) => {
            e.preventDefault();
            const gName = document.getElementById('group-name').value.trim();
            const cName = document.getElementById('creator-name').value.trim();

            const { groupId, memberId, secretCode } = await StorageService.createGroup(gName, cName);
            this.state.groupId = groupId;
            this.state.memberId = memberId;
            this.state.group = await StorageService.getGroup(groupId);
            this.updateUrlParam(groupId);
            this._attachGroupListener(groupId);

            e.target.reset();
            await this.renderSavedGroupsOnboarding();
            await this.enterMainApp({ showNoticesPopup: false });
            this.openWelcomeCodePopup(cName, secretCode);
        });

        document.getElementById('form-join-group').addEventListener('submit', async (e) => {
            e.preventDefault();
            const name = document.getElementById('join-name').value.trim();

            const { memberId, secretCode } = await StorageService.addMember(this.state.groupId, name);
            this.state.memberId = memberId;
            this.state.group = await StorageService.getGroup(this.state.groupId);
            e.target.reset();
            await this.enterMainApp({ showNoticesPopup: false });
            this.openWelcomeCodePopup(name, secretCode);
        });

        document.getElementById('form-verify-pin').addEventListener('submit', async (e) => {
            e.preventDefault();
            const targetId = document.getElementById('pin-member-id').value;
            const inputCode = document.getElementById('verify-pin-input').value.trim();
            const isValid = await StorageService.verifyMemberCode(this.state.groupId, targetId, inputCode);

            if (isValid) {
                document.getElementById('pin-error').classList.add('hidden');
                document.getElementById('modal-pin').classList.add('hidden');
                StorageService.setSession(this.state.groupId, targetId);
                this.state.memberId = targetId;
                this.state.noticesPopupShownForSession = false;
                await this.enterMainApp({ showNoticesPopup: true });
            } else {
                document.getElementById('pin-error').classList.remove('hidden');
            }
        });

        document.getElementById('btn-switch-user').addEventListener('click', () => {
            StorageService.clearMemberSession(this.state.groupId);
            this.state.memberId = null;
            this.showAuthView();
        });

        document.getElementById('btn-leave-group').addEventListener('click', () => {
            const currentMember = (this.state.group.members || []).find(m => m.id === this.state.memberId);
            const memberName = currentMember ? currentMember.name : 'tu perfil';

            this.openConfirmModal({
                title: 'Salir del grupo',
                desc: `Si sales de "${this.state.group.name}", se eliminará el perfil de ${memberName}, todo lo que tengas en Mi lista y todo lo que tengas en A comprar en este grupo.`,
                onConfirm: async () => {
                    await StorageService.leaveGroup(this.state.groupId, this.state.memberId);
                    await this.returnToOnboarding();
                }
            });
        });

        document.getElementById('btn-delete-group').addEventListener('click', () => {
            const groupName = this.state.group.name;
            this.openConfirmModal({
                title: 'Eliminar grupo completo',
                desc: `¿Seguro que quieres eliminar el grupo "${groupName}" por completo? Se borrarán todos los perfiles, listas y reservas.`,
                onConfirm: async () => {
                    const deleted = await StorageService.deleteGroup(this.state.groupId, this.state.memberId);
                    if (deleted) {
                        await this.returnToOnboarding();
                    }
                }
            });
        });

        document.getElementById('btn-edit-group-name').addEventListener('click', () => {
            document.getElementById('edit-group-name-input').value = this.state.group.name;
            document.getElementById('modal-edit-group').classList.remove('hidden');
        });

        document.getElementById('form-edit-group-name').addEventListener('submit', async (e) => {
            e.preventDefault();
            const newName = document.getElementById('edit-group-name-input').value.trim();
            if (!newName) return;
            await StorageService.updateGroupName(this.state.groupId, newName);
            document.getElementById('modal-edit-group').classList.add('hidden');
            await this.renderSavedGroupsOnboarding();
        });

        document.getElementById('btn-open-group-switcher').addEventListener('click', () => this.openGroupsModal());
        document.getElementById('btn-create-new-group-from-modal').addEventListener('click', async () => {
            document.getElementById('modal-groups').classList.add('hidden');
            await this.returnToOnboarding();
        });

        document.querySelectorAll('.nav-item[data-target]').forEach(btn => {
            btn.addEventListener('click', () => this.activateTab(btn.dataset.target));
        });

        document.getElementById('btn-nav-share').addEventListener('click', () => this.openShareModal());

        document.getElementById('btn-copy-link').addEventListener('click', () => {
            const input = document.getElementById('share-url-input');
            input.select();
            navigator.clipboard.writeText(input.value);
            document.getElementById('btn-copy-link').textContent = '¡Copiado!';
            setTimeout(() => document.getElementById('btn-copy-link').textContent = 'Copiar', 2000);
        });

        document.getElementById('btn-open-add-wish').addEventListener('click', () => {
            document.getElementById('form-add-wish').reset();
            document.getElementById('image-preview-box').classList.add('hidden');
            this.state.pendingImageDataUrl = null;
            document.getElementById('modal-add-wish').classList.remove('hidden');
        });

        document.getElementById('wish-image').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            this.compressImageForFirestore(file, (dataUrl) => {
                this.state.pendingImageDataUrl = dataUrl;
                const preview = document.getElementById('image-preview-box');
                preview.innerHTML = `<img src="${dataUrl}" alt="Vista previa">`;
                preview.classList.remove('hidden');
            });
        });

        document.getElementById('form-add-wish').addEventListener('submit', async (e) => {
            e.preventDefault();
            const title = document.getElementById('wish-title').value.trim();
            const url = document.getElementById('wish-url').value.trim();
            const note = document.getElementById('wish-note').value.trim();

            await StorageService.addWish(this.state.groupId, {
                ownerId: this.state.memberId,
                title,
                url,
                imageDataUrl: this.state.pendingImageDataUrl,
                note
            });

            document.getElementById('modal-add-wish').classList.add('hidden');
            this.activateTab('tab-my-list');
        });

        document.querySelectorAll('[data-close-modal]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.target.closest('.modal').classList.add('hidden');
            });
        });
    },

    async openGroupsModal() {
        const groups = await StorageService.getAllGroups();
        const list = document.getElementById('modal-groups-list');
        list.innerHTML = '';

        groups.forEach(g => {
            const isCurrent = g.id === this.state.groupId;
            const row = document.createElement('div');
            row.className = `group-item-row ${isCurrent ? 'active-group' : ''}`;
            row.innerHTML = `
                <div>
                    <div class="group-item-title">${g.name}</div>
                    <div class="group-item-meta">${(g.members || []).length} miembros ${isCurrent ? '· Actual' : ''}</div>
                </div>
                <i data-lucide="${isCurrent ? 'check' : 'arrow-right'}"></i>
            `;
            row.addEventListener('click', async () => {
                document.getElementById('modal-groups').classList.add('hidden');
                if (!isCurrent) {
                    await this.loadGroupContext(g);
                }
            });
            list.appendChild(row);
        });

        this.refreshIcons();
        document.getElementById('modal-groups').classList.remove('hidden');
    },

    activateTab(targetId) {
        document.querySelectorAll('.nav-item[data-target]').forEach(b => {
            b.classList.toggle('active', b.dataset.target === targetId);
        });
        document.querySelectorAll('.tab-pane').forEach(p => {
            p.classList.toggle('active', p.id === targetId);
        });
    },

    switchView(viewId) {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById(viewId).classList.add('active');
        this.refreshIcons();
    },

    updateUrlParam(groupId) {
        const url = new URL(window.location);
        url.searchParams.set('g', groupId);
        window.history.pushState({}, '', url);
    },

    showAuthView() {
        document.getElementById('auth-group-title').textContent = this.state.group.name;
        const container = document.getElementById('existing-members-list');
        container.innerHTML = '';

        (this.state.group.members || []).forEach(member => {
            const btn = document.createElement('div');
            btn.className = 'member-chip';
            btn.innerHTML = `
                <span class="chip-icon"><i data-lucide="user"></i></span>
                <span>${member.name}</span>
            `;
            btn.addEventListener('click', () => {
                document.getElementById('pin-modal-title').textContent = `Hola, ${member.name}`;
                document.getElementById('pin-member-id').value = member.id;
                document.getElementById('verify-pin-input').value = '';
                document.getElementById('pin-error').classList.add('hidden');
                document.getElementById('modal-pin').classList.remove('hidden');
            });
            container.appendChild(btn);
        });

        this.switchView('view-auth');
    },

    async enterMainApp({ showNoticesPopup = false } = {}) {
        const currentMember = (this.state.group.members || []).find(m => m.id === this.state.memberId);
        if (!currentMember) {
            this.showAuthView();
            return;
        }

        document.getElementById('profile-member-name').textContent = currentMember.name;
        document.getElementById('profile-secret-code').textContent =
            StorageService.getOwnCodeLocally(this.state.groupId, this.state.memberId);
        document.getElementById('profile-avatar-initial').textContent = currentMember.name.charAt(0).toUpperCase();

        const deleteGroupBtn = document.getElementById('btn-delete-group');
        const isCreator = this.state.group.createdBy === this.state.memberId || Boolean(currentMember.isCreator);
        deleteGroupBtn.classList.toggle('hidden', !isCreator);

        this.renderCurrentMainView();
        this.activateTab('tab-group');
        this.switchView('view-main');

        if (showNoticesPopup) {
            this.maybeOpenNextSecretNoticePopup();
        }
    },

    renderCurrentMainView() {
        if (!this.state.group || !this.state.memberId) return;
        document.getElementById('header-group-name').textContent = this.state.group.name;
        document.getElementById('profile-secret-code').textContent =
            StorageService.getOwnCodeLocally(this.state.groupId, this.state.memberId);

        this.renderSecretNotices();
        this.renderStats();
        this.renderGroupLists();
        this.renderMyList();
        this.renderMyClaims();
        this.refreshIcons();
        this.maybeOpenNextSecretNoticePopup();
    },

    renderSecretNotices() {
        const box = document.getElementById('secret-notices-box');
        const notices = (this.state.group.secretNotices || []).filter(
            n => n.recipientId === this.state.memberId
        );

        if (!notices.length) {
            box.classList.add('hidden');
            box.innerHTML = '';
            return;
        }

        box.classList.remove('hidden');
        box.innerHTML = '';

        notices.forEach(notice => {
            const card = document.createElement('div');
            card.className = 'notice-card';
            card.innerHTML = `
                <div class="notice-left">
                    <i data-lucide="bell-ring"></i>
                    <span>Aviso discreto: se ha eliminado el deseo <strong>"${notice.wishTitle}"</strong> que tenías elegido.</span>
                </div>
                <button class="notice-dismiss" onclick="WishApp.handleDismissNotice('${notice.id}')">Entendido</button>
            `;
            box.appendChild(card);
        });
    },

    async handleDismissNotice(noticeId) {
        await StorageService.dismissNotice(this.state.groupId, noticeId);
    },

    renderStats() {
        const wishes = this.state.group.wishes || [];
        const myWishes = wishes.filter(w => w.ownerId === this.state.memberId);
        const reservedOnMe = myWishes.filter(w => w.claimedBy !== null).length;

        document.getElementById('stat-my-wishes').textContent = myWishes.length;
        document.getElementById('stat-reserved-on-me').textContent = reservedOnMe;
        document.getElementById('stat-members-count').textContent = (this.state.group.members || []).length;
    },

    renderGroupLists() {
        const container = document.getElementById('group-lists-container');
        container.innerHTML = '';

        const otherMembers = (this.state.group.members || []).filter(m => m.id !== this.state.memberId);

        if (otherMembers.length === 0) {
            container.innerHTML = `
                <div class="card text-center">
                    <p class="modal-desc" style="margin-bottom:14px;">Aún no hay más personas en el grupo. Pulsa Invitar abajo para compartir el QR o enlace.</p>
                </div>`;
            return;
        }

        otherMembers.forEach(member => {
            const memberWishes = (this.state.group.wishes || []).filter(w => w.ownerId === member.id);
            const section = document.createElement('div');
            section.className = 'person-block';
            section.innerHTML = `
                <div class="person-header">
                    <span class="person-name">${member.name}</span>
                    <span class="person-count-badge">${memberWishes.length} deseos</span>
                </div>`;

            if (memberWishes.length === 0) {
                section.innerHTML += `<p class="section-sub">Sin deseos añadidos todavía.</p>`;
            } else {
                const grid = document.createElement('div');
                grid.className = 'wishes-grid';

                memberWishes.forEach(wish => {
                    const isMine = wish.claimedBy === this.state.memberId;
                    const isTakenByOther = wish.claimedBy !== null && !isMine;

                    const tile = document.createElement('div');
                    tile.className = `wish-tile ${isTakenByOther ? 'claimed-by-other' : ''}`;

                    let badgeHtml = 'Libre';
                    if (isTakenByOther) badgeHtml = `<i data-lucide="lock"></i> Elegido`;
                    if (isMine) badgeHtml = `<i data-lucide="check"></i> Tuyo`;

                    let actionHtml = '';
                    if (isTakenByOther) {
                        actionHtml = `<span class="status-pill status-taken"><i data-lucide="lock"></i> Ya elegido</span>`;
                    } else if (isMine) {
                        actionHtml = `
                            <span class="status-pill status-mine"><i data-lucide="check"></i> Elegido</span>
                            <button class="btn btn-soft-danger" onclick="WishApp.handleToggleClaim('${wish.id}')">Soltar</button>
                        `;
                    } else {
                        actionHtml = `
                            <button class="btn btn-primary btn-block" style="padding:7px 10px; font-size:0.78rem;" onclick="WishApp.handleToggleClaim('${wish.id}')">Elegir</button>
                        `;
                    }

                    tile.innerHTML = `
                        <div class="wish-thumb-wrap">
                            ${wish.imageDataUrl
                                ? `<img src="${wish.imageDataUrl}" class="wish-thumb" alt="${wish.title}" loading="lazy">`
                                : `<span class="wish-placeholder-icon"><i data-lucide="gift"></i></span>`}
                            <span class="wish-corner-tag">${badgeHtml}</span>
                        </div>
                        <div class="wish-body">
                            <div class="wish-title">${wish.title}</div>
                            ${wish.note ? `<div class="wish-note">${wish.note}</div>` : ''}
                            ${wish.url ? `<a href="${wish.url}" target="_blank" rel="noopener noreferrer" class="wish-link"><i data-lucide="external-link"></i> Ver enlace</a>` : ''}
                            <div class="wish-actions">${actionHtml}</div>
                        </div>
                    `;
                    grid.appendChild(tile);
                });

                section.appendChild(grid);
            }

            container.appendChild(section);
        });
    },

    renderMyList() {
        const myWishes = (this.state.group.wishes || []).filter(w => w.ownerId === this.state.memberId);
        const reservedCount = myWishes.filter(w => w.claimedBy !== null).length;

        document.getElementById('my-reserved-count').textContent =
            `${reservedCount} de ${myWishes.length} deseos elegidos`;

        const container = document.getElementById('my-wishes-container');
        container.innerHTML = '';

        if (myWishes.length === 0) {
            container.innerHTML = `
                <div class="card text-center">
                    <p class="modal-desc">Tu lista está vacía. Pulsa el botón + para añadir tu primer deseo.</p>
                </div>`;
            return;
        }

        const grid = document.createElement('div');
        grid.className = 'wishes-grid';

        myWishes.forEach(wish => {
            const tile = document.createElement('div');
            tile.className = 'wish-tile';
            tile.innerHTML = `
                <div class="wish-thumb-wrap">
                    ${wish.imageDataUrl
                        ? `<img src="${wish.imageDataUrl}" class="wish-thumb" alt="${wish.title}" loading="lazy">`
                        : `<span class="wish-placeholder-icon"><i data-lucide="sparkles"></i></span>`}
                    <span class="wish-corner-tag"><i data-lucide="eye-off"></i> Secreto</span>
                </div>
                <div class="wish-body">
                    <div class="wish-title">${wish.title}</div>
                    ${wish.note ? `<div class="wish-note">${wish.note}</div>` : ''}
                    ${wish.url ? `<a href="${wish.url}" target="_blank" rel="noopener noreferrer" class="wish-link"><i data-lucide="external-link"></i> Ver enlace</a>` : ''}
                    <div class="wish-actions">
                        <span class="section-sub">Oculto</span>
                        <button class="btn btn-soft-danger" onclick="WishApp.handleDeleteWish('${wish.id}')">Borrar</button>
                    </div>
                </div>
            `;
            grid.appendChild(tile);
        });

        container.appendChild(grid);
    },

    renderMyClaims() {
        const myClaims = (this.state.group.wishes || []).filter(w => w.claimedBy === this.state.memberId);
        const badge = document.getElementById('claims-badge');

        if (badge) {
            if (myClaims.length > 0) {
                badge.textContent = myClaims.length;
                badge.classList.remove('hidden');
            } else {
                badge.classList.add('hidden');
            }
        }

        const container = document.getElementById('my-claims-container');
        container.innerHTML = '';

        if (myClaims.length === 0) {
            container.innerHTML = `
                <div class="card text-center">
                    <p class="modal-desc">Aún no has elegido ningún regalo en la pestaña Grupo.</p>
                </div>`;
            return;
        }

        const grid = document.createElement('div');
        grid.className = 'wishes-grid single-col';

        myClaims.forEach(wish => {
            const owner = (this.state.group.members || []).find(m => m.id === wish.ownerId);
            const tile = document.createElement('div');
            tile.className = 'wish-tile claimable-card';
            tile.addEventListener('click', () => this.openWishDetailModal(wish.id));

            tile.innerHTML = `
                <div class="wish-thumb-wrap">
                    ${wish.imageDataUrl
                        ? `<img src="${wish.imageDataUrl}" class="wish-thumb" alt="${wish.title}" loading="lazy">`
                        : `<span class="wish-placeholder-icon"><i data-lucide="shopping-bag"></i></span>`}
                    <span class="wish-corner-tag"><i data-lucide="maximize-2"></i> Ver</span>
                </div>
                <div class="wish-body">
                    <span class="person-count-badge" style="align-self:flex-start; margin-bottom:6px;">
                        Para ${owner ? owner.name : 'Miembro'}
                    </span>
                    <div class="wish-title" style="${wish.purchased ? 'text-decoration:line-through; opacity:0.6;' : ''}">${wish.title}</div>
                    <div class="wish-actions">
                        <button type="button" class="btn ${wish.purchased ? 'btn-success' : 'btn-secondary'}" style="padding:7px 10px; font-size:0.74rem;" onclick="event.stopPropagation(); WishApp.handleTogglePurchased('${wish.id}')">
                            <i data-lucide="${wish.purchased ? 'check-circle-2' : 'circle'}"></i>
                            <span>${wish.purchased ? 'Comprado' : 'Marcar'}</span>
                        </button>
                        <button type="button" class="btn btn-soft-danger" onclick="event.stopPropagation(); WishApp.handleToggleClaim('${wish.id}')">Soltar</button>
                    </div>
                </div>
            `;
            grid.appendChild(tile);
        });

        container.appendChild(grid);
    },

    handleReleaseClaim(wishId, { onReleased = null } = {}) {
        const wish = (this.state.group.wishes || []).find(w => w.id === wishId);
        const wishName = wish ? wish.title : 'este regalo';

        this.openConfirmModal({
            title: 'Soltar regalo',
            desc: `¿Seguro que quieres soltar "${wishName}"? Quedará libre para que otra persona del grupo pueda elegirlo.`,
            onConfirm: async () => {
                await StorageService.toggleClaimWish(this.state.groupId, wishId, this.state.memberId);
                if (typeof onReleased === 'function') {
                    onReleased();
                }
            }
        });
    },

    async handleToggleClaim(wishId) {
        const wish = (this.state.group.wishes || []).find(w => w.id === wishId);
        if (!wish) return;

        if (wish.claimedBy === this.state.memberId) {
            this.handleReleaseClaim(wishId);
            return;
        }

        await StorageService.toggleClaimWish(this.state.groupId, wishId, this.state.memberId);
    },

    async handleTogglePurchased(wishId) {
        await StorageService.togglePurchased(this.state.groupId, wishId);
    },

    handleDeleteWish(wishId) {
        const wish = (this.state.group.wishes || []).find(w => w.id === wishId);
        const wishName = wish ? wish.title : 'este deseo';

        this.openConfirmModal({
            title: 'Eliminar deseo',
            desc: `¿Seguro que quieres eliminar "${wishName}" de tu lista?`,
            onConfirm: async () => {
                await StorageService.deleteWish(this.state.groupId, wishId);
            }
        });
    },

    openShareModal() {
        const shareUrl = window.location.href;
        document.getElementById('share-url-input').value = shareUrl;

        const qrContainer = document.getElementById('qrcode-container');
        qrContainer.innerHTML = '';
        new QRCode(qrContainer, {
            text: shareUrl,
            width: 176,
            height: 176,
            colorDark: "#1e2d42",
            colorLight: "#f6f9fd"
        });

        document.getElementById('modal-share').classList.remove('hidden');
    },

    compressImageForFirestore(file, callback) {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const maxWidth = 480;
                const scale = Math.min(1, maxWidth / img.width);
                canvas.width = Math.round(img.width * scale);
                canvas.height = Math.round(img.height * scale);
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                callback(canvas.toDataURL('image/jpeg', 0.65));
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    }
};

window.WishApp = WishApp;
document.addEventListener('DOMContentLoaded', () => WishApp.init());