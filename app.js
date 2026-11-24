import { AuthService, GroupService } from './firebase-service.js';
import { UIHelpers } from './ui-helpers.js';

const SoonListApp = {
    state: {
        user: null,
        groupId: null,
        group: null,
        pendingGroupToJoin: null,
        pendingImageDataUrl: null,
        activeNoticeId: null,
        pendingConfirmCallback: null,
        unsubscribeGroup: null,
        noticesPopupShownForSession: false
    },

    init() {
        this.bindEvents();
        UIHelpers.refreshIcons();

        AuthService.onAuthChange(async (user) => {
            this.state.user = user;
            const params = new URLSearchParams(window.location.search);
            const urlGroupId = params.get('g');

            if (!user) {
                this._detachGroupListener();
                this.state.groupId = null;
                this.state.group = null;
                this.showLoginView(Boolean(urlGroupId));
                return;
            }

            this.populateUserIdentityUI(user);

            if (urlGroupId) {
                const group = await GroupService.getGroup(urlGroupId);
                if (group) {
                    await this.handleGroupRouting(group);
                    return;
                }
            }

            await this.returnToOnboarding();
        });
    },

    populateUserIdentityUI(user) {
        const displayName = user.displayName || 'Usuario';
        const email = user.email || '';

        // Lobby (Onboarding)
        document.getElementById('lobby-user-name').textContent = displayName;
        document.getElementById('lobby-user-email').textContent = email;
        UIHelpers.renderAvatar(document.getElementById('lobby-user-avatar'), user.photoURL, displayName);

        const creatorInput = document.getElementById('creator-name');
        if (creatorInput && !creatorInput.value) {
            creatorInput.value = displayName;
        }

        // Vista unirse
        document.getElementById('join-user-name').textContent = displayName;
        document.getElementById('join-user-email').textContent = email;
        UIHelpers.renderAvatar(document.getElementById('join-user-avatar'), user.photoURL, displayName);

        const joinInput = document.getElementById('join-name');
        if (joinInput) {
            joinInput.value = displayName;
        }
    },

    showLoginView(hasInviteLink = false) {
        const subtitle = document.getElementById('login-subtitle');
        const errorBox = document.getElementById('login-error');
        errorBox.classList.add('hidden');
        subtitle.textContent = hasInviteLink
            ? 'Te han invitado a un grupo. Inicia sesión con tu cuenta de Google para entrar.'
            : 'Inicia sesión con tu cuenta de Google para crear o gestionar tus listas de deseos sin spoilers.';
        this.switchView('view-login');
    },

    async handleGroupRouting(group) {
        const user = this.state.user;
        if (!user) return;

        const isMember = (group.members || []).some(m => m.uid === user.uid);
        if (isMember) {
            await this.loadGroupContext(group);
        } else {
            this.state.pendingGroupToJoin = group;
            document.getElementById('join-group-title').textContent = group.name;
            document.getElementById('join-members-count').textContent =
                `${(group.members || []).length} participantes actuales`;
            this.switchView('view-join-group');
        }
    },

    _detachGroupListener() {
        if (this.state.unsubscribeGroup) {
            this.state.unsubscribeGroup();
            this.state.unsubscribeGroup = null;
        }
    },

    _attachGroupListener(groupId) {
        this._detachGroupListener();
        this.state.unsubscribeGroup = GroupService.subscribeGroup(groupId, async (updatedGroup) => {
            if (!updatedGroup) {
                await this.returnToOnboarding();
                return;
            }
            this.state.group = updatedGroup;
            const stillMember = (updatedGroup.members || []).some(m => m.uid === this.state.user?.uid);
            if (!stillMember) {
                await this.returnToOnboarding();
                return;
            }
            this.renderCurrentMainView();
        });
    },

    async loadGroupContext(group) {
        this.state.groupId = group.id;
        this.state.group = group;
        this.state.pendingGroupToJoin = null;
        this.state.noticesPopupShownForSession = false;
        this.updateUrlParam(group.id);
        this._attachGroupListener(group.id);
        await this.enterMainApp({ showNoticesPopup: true });
    },

    async returnToOnboarding() {
        this._detachGroupListener();
        this.state.groupId = null;
        this.state.group = null;
        this.state.pendingGroupToJoin = null;

        const url = new URL(window.location);
        url.searchParams.delete('g');
        window.history.pushState({}, '', url);

        if (this.state.user) {
            await this.renderUserGroupsOnboarding();
        }
        this.switchView('view-onboarding');
    },

    async renderUserGroupsOnboarding() {
        if (!this.state.user) return;
        const groups = await GroupService.getUserGroups(this.state.user.uid);
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
                    <div class="group-item-title">${UIHelpers.escapeHtml(g.name)}</div>
                    <div class="group-item-meta">${(g.members || []).length} miembros</div>
                </div>
                <i data-lucide="chevron-right"></i>
            `;
            row.addEventListener('click', () => this.loadGroupContext(g));
            list.appendChild(row);
        });
        UIHelpers.refreshIcons();
    },

    openWishDetailModal(wishId) {
        const wish = (this.state.group.wishes || []).find(w => w.id === wishId);
        if (!wish) return;

        const owner = (this.state.group.members || []).find(m => m.uid === wish.ownerUid);
        const imgBox = document.getElementById('detail-image-box');
        const imgEl = document.getElementById('detail-wish-image');

        if (wish.imageDataUrl) {
            imgEl.src = wish.imageDataUrl;
            imgEl.alt = wish.title;
            imgBox.classList.remove('hidden');
            imgBox.onclick = () => UIHelpers.openImageLightbox(wish.imageDataUrl, wish.title);
            document.getElementById('btn-zoom-detail-image').onclick = (e) => {
                e.stopPropagation();
                UIHelpers.openImageLightbox(wish.imageDataUrl, wish.title);
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
            await GroupService.togglePurchased(this.state.groupId, wish.id);
            this.openWishDetailModal(wish.id);
        });

        document.getElementById('detail-btn-unclaim').addEventListener('click', () => {
            this.handleReleaseClaim(wish.id, {
                onReleased: () => {
                    document.getElementById('modal-wish-detail').classList.add('hidden');
                }
            });
        });

        UIHelpers.refreshIcons();
        document.getElementById('modal-wish-detail').classList.remove('hidden');
    },

    openConfirmModal({ title, desc, onConfirm }) {
        document.getElementById('confirm-modal-title').textContent = title;
        document.getElementById('confirm-modal-desc').textContent = desc;
        this.state.pendingConfirmCallback = onConfirm;
        UIHelpers.refreshIcons();
        document.getElementById('modal-confirm').classList.remove('hidden');
    },

    maybeOpenNextSecretNoticePopup() {
        if (this.state.noticesPopupShownForSession || !this.state.user) return;
        const notices = (this.state.group.secretNotices || []).filter(
            n => n.recipientUid === this.state.user.uid
        );
        if (!notices.length) return;

        this.state.noticesPopupShownForSession = true;
        const firstNotice = notices[0];
        this.state.activeNoticeId = firstNotice.id;
        document.getElementById('popup-notice-message').textContent =
            `Aviso discreto: se ha eliminado el deseo "${firstNotice.wishTitle}" que tenías elegido.`;
        UIHelpers.refreshIcons();
        document.getElementById('modal-secret-notice').classList.remove('hidden');
    },

    bindEvents() {
        // Login y Logout de Google
        document.getElementById('btn-google-login').addEventListener('click', async () => {
            const btn = document.getElementById('btn-google-login');
            const errorBox = document.getElementById('login-error');
            errorBox.classList.add('hidden');
            btn.disabled = true;
            try {
                await AuthService.loginWithGoogle();
            } catch (err) {
                console.error('Error al iniciar sesión con Google:', err);
                errorBox.textContent = 'No se pudo completar el acceso con Google. Inténtalo de nuevo.';
                errorBox.classList.remove('hidden');
            } finally {
                btn.disabled = false;
            }
        });

        ['btn-logout-lobby', 'btn-logout-join', 'btn-logout-main'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('click', async () => {
                    await AuthService.logout();
                });
            }
        });

        document.getElementById('btn-cancel-join').addEventListener('click', async () => {
            await this.returnToOnboarding();
        });

        // Lightbox y confirmaciones
        document.getElementById('btn-close-lightbox').addEventListener('click', () => UIHelpers.closeImageLightbox());
        document.getElementById('modal-image-lightbox').addEventListener('click', (e) => {
            if (e.target.id === 'modal-image-lightbox') UIHelpers.closeImageLightbox();
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

        document.getElementById('btn-confirm-secret-notice').addEventListener('click', async () => {
            const noticeId = this.state.activeNoticeId;
            this.state.activeNoticeId = null;
            document.getElementById('modal-secret-notice').classList.add('hidden');
            if (noticeId) {
                await GroupService.dismissNotice(this.state.groupId, noticeId);
                this.state.noticesPopupShownForSession = false;
                this.maybeOpenNextSecretNoticePopup();
            }
        });

        // Crear grupo
        document.getElementById('form-create-group').addEventListener('submit', async (e) => {
            e.preventDefault();
            const gName = document.getElementById('group-name').value.trim();
            const cName = document.getElementById('creator-name').value.trim();

            const createdGroup = await GroupService.createGroup(gName, cName);
            e.target.reset();
            document.getElementById('creator-name').value = this.state.user?.displayName || cName;
            await this.loadGroupContext(createdGroup);
        });

        // Unirse a grupo invitado
        document.getElementById('form-join-group').addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!this.state.pendingGroupToJoin) return;
            const name = document.getElementById('join-name').value.trim();

            const joinedGroup = await GroupService.joinGroup(this.state.pendingGroupToJoin.id, name);
            await this.loadGroupContext(joinedGroup);
        });

        // Salir o eliminar grupo
        document.getElementById('btn-leave-group').addEventListener('click', () => {
            const currentMember = (this.state.group.members || []).find(m => m.uid === this.state.user.uid);
            const memberName = currentMember ? currentMember.name : 'tu cuenta';

            this.openConfirmModal({
                title: 'Salir del grupo',
                desc: `Si sales de "${this.state.group.name}", se eliminará tu perfil (${memberName}), todo lo que tengas en Mi lista y tus reservas en este grupo.`,
                onConfirm: async () => {
                    await GroupService.leaveGroup(this.state.groupId, this.state.user.uid);
                    await this.returnToOnboarding();
                }
            });
        });

        document.getElementById('btn-delete-group').addEventListener('click', () => {
            const groupName = this.state.group.name;
            this.openConfirmModal({
                title: 'Eliminar grupo completo',
                desc: `¿Seguro que quieres eliminar el grupo "${groupName}" por completo? Se borrarán todos los miembros, listas y reservas.`,
                onConfirm: async () => {
                    const deleted = await GroupService.deleteGroup(this.state.groupId, this.state.user.uid);
                    if (deleted) {
                        await this.returnToOnboarding();
                    }
                }
            });
        });

        // Editar nombre del grupo
        document.getElementById('btn-edit-group-name').addEventListener('click', () => {
            document.getElementById('edit-group-name-input').value = this.state.group.name;
            document.getElementById('modal-edit-group').classList.remove('hidden');
        });

        document.getElementById('form-edit-group-name').addEventListener('submit', async (e) => {
            e.preventDefault();
            const newName = document.getElementById('edit-group-name-input').value.trim();
            if (!newName) return;
            await GroupService.updateGroupName(this.state.groupId, newName);
            document.getElementById('modal-edit-group').classList.add('hidden');
        });

        // Selector de grupos
        document.getElementById('btn-open-group-switcher').addEventListener('click', () => this.openGroupsModal());
        document.getElementById('btn-create-new-group-from-modal').addEventListener('click', async () => {
            document.getElementById('modal-groups').classList.add('hidden');
            await this.returnToOnboarding();
        });

        // Navegación
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

        // Añadir deseo
        document.getElementById('btn-open-add-wish').addEventListener('click', () => {
            document.getElementById('form-add-wish').reset();
            document.getElementById('image-preview-box').classList.add('hidden');
            this.state.pendingImageDataUrl = null;
            document.getElementById('modal-add-wish').classList.remove('hidden');
        });

        document.getElementById('wish-image').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            UIHelpers.compressImageForFirestore(file, (dataUrl) => {
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

            await GroupService.addWish(this.state.groupId, {
                ownerUid: this.state.user.uid,
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
        const groups = await GroupService.getUserGroups(this.state.user.uid);
        const list = document.getElementById('modal-groups-list');
        list.innerHTML = '';

        groups.forEach(g => {
            const isCurrent = g.id === this.state.groupId;
            const row = document.createElement('div');
            row.className = `group-item-row ${isCurrent ? 'active-group' : ''}`;
            row.innerHTML = `
                <div>
                    <div class="group-item-title">${UIHelpers.escapeHtml(g.name)}</div>
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

        UIHelpers.refreshIcons();
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
        UIHelpers.refreshIcons();
    },

    updateUrlParam(groupId) {
        const url = new URL(window.location);
        url.searchParams.set('g', groupId);
        window.history.pushState({}, '', url);
    },

    async enterMainApp({ showNoticesPopup = false } = {}) {
        const currentMember = (this.state.group.members || []).find(m => m.uid === this.state.user.uid);
        if (!currentMember) {
            await this.returnToOnboarding();
            return;
        }

        const displayName = currentMember.name || this.state.user.displayName || 'Usuario';
        const email = currentMember.email || this.state.user.email || '';
        const photoURL = currentMember.photoURL || this.state.user.photoURL || '';

        document.getElementById('profile-member-name').textContent = displayName;
        document.getElementById('profile-member-email').textContent = email;
        UIHelpers.renderAvatar(document.getElementById('profile-avatar-box'), photoURL, displayName);

        const deleteGroupBtn = document.getElementById('btn-delete-group');
        const isCreator = this.state.group.createdByUid === this.state.user.uid || Boolean(currentMember.isCreator);
        deleteGroupBtn.classList.toggle('hidden', !isCreator);

        this.renderCurrentMainView();
        this.activateTab('tab-group');
        this.switchView('view-main');

        if (showNoticesPopup) {
            this.maybeOpenNextSecretNoticePopup();
        }
    },

    renderCurrentMainView() {
        if (!this.state.group || !this.state.user) return;
        document.getElementById('header-group-name').textContent = this.state.group.name;

        this.renderSecretNotices();
        this.renderStats();
        this.renderGroupLists();
        this.renderMyList();
        this.renderMyClaims();
        UIHelpers.refreshIcons();
        this.maybeOpenNextSecretNoticePopup();
    },

    renderSecretNotices() {
        const box = document.getElementById('secret-notices-box');
        const notices = (this.state.group.secretNotices || []).filter(
            n => n.recipientUid === this.state.user.uid
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
                    <span>Aviso discreto: se ha eliminado el deseo <strong>"${UIHelpers.escapeHtml(notice.wishTitle)}"</strong> que tenías elegido.</span>
                </div>
                <button class="notice-dismiss" onclick="SoonListApp.handleDismissNotice('${notice.id}')">Entendido</button>
            `;
            box.appendChild(card);
        });
    },

    async handleDismissNotice(noticeId) {
        await GroupService.dismissNotice(this.state.groupId, noticeId);
    },

    renderStats() {
        const wishes = this.state.group.wishes || [];
        const myWishes = wishes.filter(w => w.ownerUid === this.state.user.uid);
        const reservedOnMe = myWishes.filter(w => w.claimedByUid !== null).length;

        document.getElementById('stat-my-wishes').textContent = myWishes.length;
        document.getElementById('stat-reserved-on-me').textContent = reservedOnMe;
        document.getElementById('stat-members-count').textContent = (this.state.group.members || []).length;
    },

    renderGroupLists() {
        const container = document.getElementById('group-lists-container');
        container.innerHTML = '';

        const otherMembers = (this.state.group.members || []).filter(m => m.uid !== this.state.user.uid);

        if (otherMembers.length === 0) {
            container.innerHTML = `
                <div class="card text-center">
                    <p class="modal-desc" style="margin-bottom:14px;">Aún no hay más personas en el grupo. Pulsa Invitar abajo para compartir el QR o enlace.</p>
                </div>`;
            return;
        }

        otherMembers.forEach(member => {
            const memberWishes = (this.state.group.wishes || []).filter(w => w.ownerUid === member.uid);
            const section = document.createElement('div');
            section.className = 'person-block';
            section.innerHTML = `
                <div class="person-header">
                    <div class="person-identity">
                        ${member.photoURL
                            ? `<img src="${UIHelpers.escapeHtml(member.photoURL)}" alt="${UIHelpers.escapeHtml(member.name)}" class="person-mini-avatar" referrerpolicy="no-referrer">`
                            : `<span class="person-mini-avatar-fallback">${UIHelpers.escapeHtml(member.name.charAt(0).toUpperCase())}</span>`}
                        <span class="person-name">${UIHelpers.escapeHtml(member.name)}</span>
                    </div>
                    <span class="person-count-badge">${memberWishes.length} deseos</span>
                </div>`;

            if (memberWishes.length === 0) {
                section.innerHTML += `<p class="section-sub">Sin deseos añadidos todavía.</p>`;
            } else {
                const grid = document.createElement('div');
                grid.className = 'wishes-grid';

                memberWishes.forEach(wish => {
                    const isMine = wish.claimedByUid === this.state.user.uid;
                    const isTakenByOther = wish.claimedByUid !== null && !isMine;

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
                            <button class="btn btn-soft-danger" onclick="SoonListApp.handleToggleClaim('${wish.id}')">Soltar</button>
                        `;
                    } else {
                        actionHtml = `
                            <button class="btn btn-primary btn-block" style="padding:7px 10px; font-size:0.78rem;" onclick="SoonListApp.handleToggleClaim('${wish.id}')">Elegir</button>
                        `;
                    }

                    tile.innerHTML = `
                        <div class="wish-thumb-wrap">
                            ${wish.imageDataUrl
                                ? `<img src="${wish.imageDataUrl}" class="wish-thumb" alt="${UIHelpers.escapeHtml(wish.title)}" loading="lazy">`
                                : `<span class="wish-placeholder-icon"><i data-lucide="gift"></i></span>`}
                            <span class="wish-corner-tag">${badgeHtml}</span>
                        </div>
                        <div class="wish-body">
                            <div class="wish-title">${UIHelpers.escapeHtml(wish.title)}</div>
                            ${wish.note ? `<div class="wish-note">${UIHelpers.escapeHtml(wish.note)}</div>` : ''}
                            ${wish.url ? `<a href="${UIHelpers.escapeHtml(wish.url)}" target="_blank" rel="noopener noreferrer" class="wish-link"><i data-lucide="external-link"></i> Ver enlace</a>` : ''}
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
        const myWishes = (this.state.group.wishes || []).filter(w => w.ownerUid === this.state.user.uid);
        const reservedCount = myWishes.filter(w => w.claimedByUid !== null).length;

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
                        ? `<img src="${wish.imageDataUrl}" class="wish-thumb" alt="${UIHelpers.escapeHtml(wish.title)}" loading="lazy">`
                        : `<span class="wish-placeholder-icon"><i data-lucide="sparkles"></i></span>`}
                    <span class="wish-corner-tag"><i data-lucide="eye-off"></i> Secreto</span>
                </div>
                <div class="wish-body">
                    <div class="wish-title">${UIHelpers.escapeHtml(wish.title)}</div>
                    ${wish.note ? `<div class="wish-note">${UIHelpers.escapeHtml(wish.note)}</div>` : ''}
                    ${wish.url ? `<a href="${UIHelpers.escapeHtml(wish.url)}" target="_blank" rel="noopener noreferrer" class="wish-link"><i data-lucide="external-link"></i> Ver enlace</a>` : ''}
                    <div class="wish-actions">
                        <span class="section-sub">Oculto</span>
                        <button class="btn btn-soft-danger" onclick="SoonListApp.handleDeleteWish('${wish.id}')">Borrar</button>
                    </div>
                </div>
            `;
            grid.appendChild(tile);
        });

        container.appendChild(grid);
    },

    renderMyClaims() {
        const myClaims = (this.state.group.wishes || []).filter(w => w.claimedByUid === this.state.user.uid);
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
            const owner = (this.state.group.members || []).find(m => m.uid === wish.ownerUid);
            const tile = document.createElement('div');
            tile.className = 'wish-tile claimable-card';
            tile.addEventListener('click', () => this.openWishDetailModal(wish.id));

            tile.innerHTML = `
                <div class="wish-thumb-wrap">
                    ${wish.imageDataUrl
                        ? `<img src="${wish.imageDataUrl}" class="wish-thumb" alt="${UIHelpers.escapeHtml(wish.title)}" loading="lazy">`
                        : `<span class="wish-placeholder-icon"><i data-lucide="shopping-bag"></i></span>`}
                    <span class="wish-corner-tag"><i data-lucide="maximize-2"></i> Ver</span>
                </div>
                <div class="wish-body">
                    <span class="person-count-badge" style="align-self:flex-start; margin-bottom:6px;">
                        Para ${UIHelpers.escapeHtml(owner ? owner.name : 'Miembro')}
                    </span>
                    <div class="wish-title" style="${wish.purchased ? 'text-decoration:line-through; opacity:0.6;' : ''}">${UIHelpers.escapeHtml(wish.title)}</div>
                    <div class="wish-actions">
                        <button type="button" class="btn ${wish.purchased ? 'btn-success' : 'btn-secondary'}" style="padding:7px 10px; font-size:0.74rem;" onclick="event.stopPropagation(); SoonListApp.handleTogglePurchased('${wish.id}')">
                            <i data-lucide="${wish.purchased ? 'check-circle-2' : 'circle'}"></i>
                            <span>${wish.purchased ? 'Comprado' : 'Marcar'}</span>
                        </button>
                        <button type="button" class="btn btn-soft-danger" onclick="event.stopPropagation(); SoonListApp.handleToggleClaim('${wish.id}')">Soltar</button>
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
                await GroupService.toggleClaimWish(this.state.groupId, wishId, this.state.user.uid);
                if (typeof onReleased === 'function') {
                    onReleased();
                }
            }
        });
    },

    async handleToggleClaim(wishId) {
        const wish = (this.state.group.wishes || []).find(w => w.id === wishId);
        if (!wish) return;

        if (wish.claimedByUid === this.state.user.uid) {
            this.handleReleaseClaim(wishId);
            return;
        }

        await GroupService.toggleClaimWish(this.state.groupId, wishId, this.state.user.uid);
    },

    async handleTogglePurchased(wishId) {
        await GroupService.togglePurchased(this.state.groupId, wishId);
    },

    handleDeleteWish(wishId) {
        const wish = (this.state.group.wishes || []).find(w => w.id === wishId);
        const wishName = wish ? wish.title : 'este deseo';

        this.openConfirmModal({
            title: 'Eliminar deseo',
            desc: `¿Seguro que quieres eliminar "${wishName}" de tu lista?`,
            onConfirm: async () => {
                await GroupService.deleteWish(this.state.groupId, wishId);
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
    }
};

window.SoonListApp = SoonListApp;
document.addEventListener('DOMContentLoaded', () => SoonListApp.init());