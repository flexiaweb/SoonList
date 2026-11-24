import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
    getAuth,
    GoogleAuthProvider,
    signInWithPopup,
    signOut,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
    getFirestore,
    doc,
    getDoc,
    setDoc,
    updateDoc,
    deleteDoc,
    collection,
    query,
    where,
    getDocs,
    onSnapshot
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

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
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export const AuthService = {
    getCurrentUser() {
        return auth.currentUser;
    },

    onAuthChange(callback) {
        return onAuthStateChanged(auth, callback);
    },

    async loginWithGoogle() {
        const result = await signInWithPopup(auth, googleProvider);
        return result.user;
    },

    async logout() {
        await signOut(auth);
    }
};

export const GroupService = {
    async createGroup(groupName, customDisplayName) {
        const user = auth.currentUser;
        if (!user) throw new Error('Debes iniciar sesión con Google.');

        const groupId = 'grp_' + Math.random().toString(36).substring(2, 10);
        const memberName = (customDisplayName || user.displayName || 'Usuario').trim();

        const groupDoc = {
            id: groupId,
            name: groupName,
            createdByUid: user.uid,
            createdAt: Date.now(),
            memberUids: [user.uid],
            members: [
                {
                    uid: user.uid,
                    name: memberName,
                    email: user.email || '',
                    photoURL: user.photoURL || '',
                    isCreator: true
                }
            ],
            wishes: [],
            secretNotices: []
        };

        await setDoc(doc(db, 'groups', groupId), groupDoc);
        return groupDoc;
    },

    async getGroup(groupId) {
        const snap = await getDoc(doc(db, 'groups', groupId));
        return snap.exists() ? snap.data() : null;
    },

    subscribeGroup(groupId, onUpdate) {
        return onSnapshot(doc(db, 'groups', groupId), (snap) => {
            onUpdate(snap.exists() ? snap.data() : null);
        });
    },

    async getUserGroups(uid) {
        const q = query(collection(db, 'groups'), where('memberUids', 'array-contains', uid));
        const snap = await getDocs(q);
        const groups = snap.docs.map(d => d.data());
        return groups.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    },

    async joinGroup(groupId, customDisplayName) {
        const user = auth.currentUser;
        if (!user) throw new Error('Debes iniciar sesión con Google.');

        const groupRef = doc(db, 'groups', groupId);
        const snap = await getDoc(groupRef);
        if (!snap.exists()) throw new Error('Grupo no encontrado.');

        const group = snap.data();
        const existingMember = (group.members || []).find(m => m.uid === user.uid);
        if (existingMember) return group;

        const memberName = (customDisplayName || user.displayName || 'Usuario').trim();
        const updatedMembers = [
            ...(group.members || []),
            {
                uid: user.uid,
                name: memberName,
                email: user.email || '',
                photoURL: user.photoURL || '',
                isCreator: false
            }
        ];

        const updatedUids = Array.from(new Set([...(group.memberUids || []), user.uid]));

        await updateDoc(groupRef, {
            members: updatedMembers,
            memberUids: updatedUids
        });

        return { ...group, members: updatedMembers, memberUids: updatedUids };
    },

    async updateGroupName(groupId, newName) {
        await updateDoc(doc(db, 'groups', groupId), { name: newName });
    },

    async deleteGroup(groupId, requesterUid) {
        const groupRef = doc(db, 'groups', groupId);
        const snap = await getDoc(groupRef);
        if (!snap.exists()) return false;

        const group = snap.data();
        if (group.createdByUid !== requesterUid) return false;

        await deleteDoc(groupRef);
        return true;
    },

    async leaveGroup(groupId, memberUid) {
        const groupRef = doc(db, 'groups', groupId);
        const snap = await getDoc(groupRef);
        if (!snap.exists()) return;

        const group = snap.data();
        const updatedMembers = (group.members || []).filter(m => m.uid !== memberUid);
        const updatedUids = (group.memberUids || []).filter(uid => uid !== memberUid);
        const updatedWishes = (group.wishes || [])
            .filter(w => w.ownerUid !== memberUid)
            .map(w => w.claimedByUid === memberUid ? { ...w, claimedByUid: null, purchased: false } : w);
        const updatedNotices = (group.secretNotices || []).filter(n => n.recipientUid !== memberUid);

        await updateDoc(groupRef, {
            members: updatedMembers,
            memberUids: updatedUids,
            wishes: updatedWishes,
            secretNotices: updatedNotices
        });
    },

    async addWish(groupId, wishData) {
        const groupRef = doc(db, 'groups', groupId);
        const snap = await getDoc(groupRef);
        if (!snap.exists()) return null;

        const group = snap.data();
        const wishId = 'wsh_' + Math.random().toString(36).substring(2, 10);

        const newWish = {
            id: wishId,
            ownerUid: wishData.ownerUid,
            title: wishData.title,
            url: wishData.url || '',
            note: wishData.note || '',
            imageDataUrl: wishData.imageDataUrl || null,
            claimedByUid: null,
            purchased: false,
            createdAt: Date.now()
        };

        await updateDoc(groupRef, {
            wishes: [...(group.wishes || []), newWish]
        });

        return newWish;
    },

    async deleteWish(groupId, wishId) {
        const groupRef = doc(db, 'groups', groupId);
        const snap = await getDoc(groupRef);
        if (!snap.exists()) return;

        const group = snap.data();
        const wishes = group.wishes || [];
        const targetWish = wishes.find(w => w.id === wishId);
        const secretNotices = [...(group.secretNotices || [])];

        if (targetWish && targetWish.claimedByUid) {
            secretNotices.push({
                id: 'ntc_' + Math.random().toString(36).substring(2, 10),
                recipientUid: targetWish.claimedByUid,
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
        const groupRef = doc(db, 'groups', groupId);
        const snap = await getDoc(groupRef);
        if (!snap.exists()) return;

        const group = snap.data();
        const secretNotices = (group.secretNotices || []).filter(n => n.id !== noticeId);
        await updateDoc(groupRef, { secretNotices });
    },

    async toggleClaimWish(groupId, wishId, claimerUid) {
        const groupRef = doc(db, 'groups', groupId);
        const snap = await getDoc(groupRef);
        if (!snap.exists()) return;

        const group = snap.data();
        const wishes = (group.wishes || []).map(w => {
            if (w.id !== wishId) return w;
            if (w.claimedByUid === null) {
                return { ...w, claimedByUid: claimerUid, purchased: false };
            }
            if (w.claimedByUid === claimerUid) {
                return { ...w, claimedByUid: null, purchased: false };
            }
            return w;
        });

        await updateDoc(groupRef, { wishes });
    },

    async togglePurchased(groupId, wishId) {
        const groupRef = doc(db, 'groups', groupId);
        const snap = await getDoc(groupRef);
        if (!snap.exists()) return;

        const group = snap.data();
        const wishes = (group.wishes || []).map(w =>
            w.id === wishId ? { ...w, purchased: !w.purchased } : w
        );

        await updateDoc(groupRef, { wishes });
    }
};