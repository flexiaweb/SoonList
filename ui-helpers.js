export const UIHelpers = {
    refreshIcons() {
        if (window.lucide) {
            window.lucide.createIcons();
        }
    },

    escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    },

    renderAvatar(containerEl, photoURL, fallbackName) {
        const initial = (fallbackName || 'U').trim().charAt(0).toUpperCase();
        if (photoURL) {
            containerEl.innerHTML = `<img src="${this.escapeHtml(photoURL)}" alt="${this.escapeHtml(fallbackName)}" class="avatar-img" referrerpolicy="no-referrer">`;
        } else {
            containerEl.textContent = initial;
        }
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
    }
};