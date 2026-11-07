// Keep user-controlled names as text even inside template-built controls.
function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

class SoundPlayer {
    constructor() {
        this.audioContext = null;
        this.audioElement = new Audio();
        this.audioSource = null;
        this.analyser = null;
        this.folders = new Map();
        this.currentFolder = 'all';
        this.files = new Map();
        this.currentTrack = null;
        this.isPlaying = false;
        this.isShuffleOn = false;
        this.isRepeatOneOn = false;
        this.db = null;
        this.selectedFiles = new Set();
        this.searchQuery = '';
        this.filteredFiles = new Set();
        this.isSeeking = false;
        this.isAutoScrollOn = true; // Auto-scroll enabled by default
        this.activeObjectURLs = new Set(); // Track active blob URLs for cleanup

        this.ready = this.initDB().then(async () => {
            this.createDefaultFolder();
            this.setupEventListeners();
            await this.loadState();
            this.bindPersistence();
        });
    }

    async initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('SoundPlayerDB', 1);

            request.onerror = () => reject(request.error);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('files')) {
                    db.createObjectStore('files');
                }
                if (!db.objectStoreNames.contains('state')) {
                    db.createObjectStore('state');
                }
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                resolve();
            };
        });
    }

    cleanupObjectURL(url) {
        if (this.activeObjectURLs.has(url)) {
            URL.revokeObjectURL(url);
            this.activeObjectURLs.delete(url);
        }
    }

    cleanupAllObjectURLs() {
        this.activeObjectURLs.forEach(url => {
            URL.revokeObjectURL(url);
        });
        this.activeObjectURLs.clear();
    }

    showNotification(message, type = 'info', duration = 3000) {
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.textContent = message;

        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 12px 20px;
            border-radius: 6px;
            z-index: 10000;
            max-width: 300px;
            word-wrap: break-word;
            animation: slideIn 0.3s ease;
        `;

        if (type === 'error') {
            notification.style.backgroundColor = '#dc3545';
            notification.style.color = 'white';
        } else if (type === 'success') {
            notification.style.backgroundColor = '#28a745';
            notification.style.color = 'white';
        } else {
            notification.style.backgroundColor = '#007bff';
            notification.style.color = 'white';
        }

        document.body.appendChild(notification);

        setTimeout(() => {
            notification.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => {
                if (document.body.contains(notification)) {
                    document.body.removeChild(notification);
                }
            }, 300);
        }, duration);
    }

    showSimpleLoading(message) {
        const dialog = document.createElement('div');
        dialog.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(30, 30, 30, 0.95);
            color: white;
            padding: 20px;
            border-radius: 8px;
            z-index: 1000;
            min-width: 200px;
            text-align: center;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        `;

        const messageEl = document.createElement('div');
        messageEl.textContent = message;
        messageEl.style.marginBottom = '15px';
        dialog.appendChild(messageEl);

        const spinner = document.createElement('div');
        spinner.style.cssText = `
            width: 20px;
            height: 20px;
            border: 2px solid #666;
            border-top-color: #8b5cf6;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto;
        `;
        dialog.appendChild(spinner);

        document.body.appendChild(dialog);
        return dialog;
    }

    async handleFileUpload(event) {
        const incoming = Array.from(event.target.files || []);
        event.target.value = '';
        if (!incoming.length || this.libraryBusy) return;
        this.libraryBusy = true;
        document.querySelector('.app-container').inert = true;
        let added = 0, failed = 0;
        const loading = incoming.length > 1 ? this.showSimpleLoading(`Importing ${incoming.length} files…`) : null;
        try {
            this.createDefaultFolder();
            if (!this.folders.has(this.currentFolder)) this.currentFolder = 'all';
            for (const file of incoming) {
                if (!file.type.startsWith('audio/') && !/\.(mp3|wav|ogg|flac|m4a|aac|opus|aiff?|webm)$/i.test(file.name)) {
                    failed++; continue;
                }
                const id = crypto.randomUUID();
                try {
                    // Store the Blob directly; avoid FileReader's extra full-file ArrayBuffer copy.
                    await this.storeFile(id, file);
                    this.files.set(id, { id, name: file.name, type: file.type, size: file.size });
                    this.folders.get(this.currentFolder).files.add(id);
                    this.folders.get('all').files.add(id);
                    added++;
                } catch (error) { failed++; console.warn('Import failed', error.name); }
                if ((added + failed) % 20 === 0) await new Promise(resolve => setTimeout(resolve, 0));
            }
            await this.saveState();
            this.updateFilesList();
            this.showNotification(`Added ${added} files${failed ? `; ${failed} unsupported or failed` : ''}`, failed ? 'error' : 'success');
        } finally {
            this.libraryBusy = false;
            document.querySelector('.app-container').inert = false;
            loading?.remove();
        }
    }

    saveState() {
        const state = {
            folders: Array.from(this.folders.entries()).map(([id, folder]) => ({
                id,
                name: folder.name,
                files: Array.from(folder.files || [])
            })),
            files: Array.from(this.files.entries()).map(([id, file]) => ({
                id,
                name: file.name, type: file.type, size: file.size
            })),
            currentFolder: this.currentFolder,
            currentTrack: this.currentTrack,
            isShuffleOn: this.isShuffleOn,
            isRepeatOneOn: this.isRepeatOneOn,
            isAutoScrollOn: this.isAutoScrollOn,
            playbackPosition: this.audioElement.src ? this.audioElement.currentTime : (this.resumePosition || 0),
            volume: this.audioElement.volume
        };

        const transaction = this.db.transaction(['state'], 'readwrite');
        const store = transaction.objectStore('state');

        return new Promise((resolve, reject) => {
            const request = store.put(state, 'currentState');
            transaction.oncomplete = () => resolve();
            transaction.onabort = () => reject(transaction.error || new Error('State transaction aborted'));
            request.onerror = () => {
                console.error('Failed to save state:', request.error);
                reject(request.error);
            };
        });
    }

    async loadState() {
        const transaction = this.db.transaction('state', 'readonly');
        const state = await new Promise((resolve, reject) => {
            const request = transaction.objectStore('state').get('currentState');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        if (!state) return;
        this.cleanupAllObjectURLs();
        this.files = new Map((state.files || []).map(file => [file.id, { ...file, url: undefined }]));
        this.folders = new Map((state.folders || []).map(folder => [folder.id, {
            name: folder.name, files: new Set((folder.files || []).filter(id => this.files.has(id)))
        }]));
        this.createDefaultFolder();
        this.files.forEach((_, id) => this.folders.get('all').files.add(id));
        this.currentFolder = this.folders.has(state.currentFolder) ? state.currentFolder : 'all';
        this.currentTrack = this.files.has(state.currentTrack) ? state.currentTrack : null;
        this.resumePosition = Number.isFinite(state.playbackPosition) ? Math.max(0, state.playbackPosition) : 0;
        this.audioElement.volume = Number.isFinite(state.volume) ? Math.max(0, Math.min(1, state.volume)) : 1;
        document.getElementById('volumeSlider').value = this.audioElement.volume * 100;
        this.isShuffleOn = !!state.isShuffleOn;
        this.isRepeatOneOn = !!state.isRepeatOneOn;
        this.isAutoScrollOn = state.isAutoScrollOn !== false;
        for (const [id, enabled] of [['shuffleBtn', this.isShuffleOn], ['repeatOneBtn', this.isRepeatOneOn], ['autoScrollBtn', this.isAutoScrollOn]]) {
            document.getElementById(id)?.classList.toggle('active', enabled);
        }
        this.updateFoldersList();
        this.updateFilesList();
        document.getElementById('currentFolderName').textContent = this.folders.get(this.currentFolder).name;
        document.getElementById('currentTrack').textContent = this.files.get(this.currentTrack)?.name || 'No track selected';
    }

    bindPersistence() {
        const save = () => { if (!this.libraryBusy) this.saveState().catch(error => console.warn('State persistence failed', error.name)); };
        this.audioElement.addEventListener('timeupdate', () => {
            if (Date.now() - (this.lastPositionSave || 0) > 5000) { this.lastPositionSave = Date.now(); save(); }
        });
        for (const event of ['pause', 'seeked', 'volumechange']) this.audioElement.addEventListener(event, save);
        window.addEventListener('pagehide', save);
        this.audioElement.addEventListener('error', () => this.showNotification('This audio file could not be played. Try another supported format.', 'error'));
        this.audioElement.addEventListener('loadedmetadata', () => {
            if (this.pendingResume > 0 && Number.isFinite(this.audioElement.duration)) {
                this.audioElement.currentTime = Math.min(this.pendingResume, this.audioElement.duration);
            }
            this.pendingResume = 0;
        });
        if ('mediaSession' in navigator) {
            for (const [action, handler] of [['play', () => this.play()], ['pause', () => this.pause()],
                ['nexttrack', () => this.playNext()], ['previoustrack', () => this.playPrevious()]]) {
                navigator.mediaSession.setActionHandler(action, handler);
            }
        }
    }

    async ensureAudioURL(fileId) {
        const file = this.files.get(fileId);
        if (!file) throw new Error('Track is missing');
        if (!file.url) {
            const data = await this.getFile(fileId);
            if (!data) throw new Error('Audio data is missing; restore a library backup');
            file.url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type: file.type || '' }));
            this.activeObjectURLs.add(file.url);
        }
        return file.url;
    }

    initializeAudioContext() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.audioSource = this.audioContext.createMediaElementSource(this.audioElement);
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 256;
            this.audioSource.connect(this.analyser);
            this.analyser.connect(this.audioContext.destination);
            this.setupVisualizer();
        }
    }

    setupVisualizer() {
        const canvas = document.getElementById('visualizer');
        const ctx = canvas.getContext('2d');

        // Set canvas size to match its display size
        const resizeCanvas = () => {
            const rect = canvas.getBoundingClientRect();
            canvas.width = rect.width * window.devicePixelRatio;
            canvas.height = rect.height * window.devicePixelRatio;
            ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
        };

        // Resize canvas initially and on window resize
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);

        const bufferLength = this.analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        const draw = () => {
            const WIDTH = canvas.width / window.devicePixelRatio;
            const HEIGHT = canvas.height / window.devicePixelRatio;

            requestAnimationFrame(draw);

            this.analyser.getByteFrequencyData(dataArray);

            ctx.fillStyle = 'rgb(0, 0, 0)';
            ctx.fillRect(0, 0, WIDTH, HEIGHT);

            const barWidth = (WIDTH / bufferLength) * 2.5;
            let barHeight;
            let x = 0;

            for (let i = 0; i < bufferLength; i++) {
                barHeight = (dataArray[i] / 255) * HEIGHT;

                const gradient = ctx.createLinearGradient(0, HEIGHT, 0, HEIGHT - barHeight);
                gradient.addColorStop(0, '#8b5cf6');  // Primary color at bottom
                gradient.addColorStop(1, '#7c3aed');  // Darker shade at top

                ctx.fillStyle = gradient;
                ctx.fillRect(x, HEIGHT - barHeight, barWidth, barHeight);

                x += barWidth + 1;
            }
        };

        draw();
    }

    setupEventListeners() {
        console.log('Setting up event listeners...');

        // File upload
        const fileUploadBtn = document.getElementById('fileUpload');
        console.log('File upload button:', fileUploadBtn);
        if (fileUploadBtn) {
            fileUploadBtn.addEventListener('click', () => {
                const input = document.createElement('input');
                input.type = 'file';
                input.multiple = true;
                input.accept = 'audio/*';
                input.onchange = (e) => this.handleFileUpload(e);
                input.click();
            });
        }

        // New folder button
        const newFolderBtn = document.getElementById('newFolderBtn');
        if (newFolderBtn) {
            newFolderBtn.addEventListener('click', () => {
                this.createNewFolder();
            });
        }

        // Playback controls
        const playBtn = document.getElementById('playBtn');
        if (playBtn) {
            playBtn.addEventListener('click', () => this.togglePlay());
        }

        const prevBtn = document.getElementById('prevBtn');
        if (prevBtn) {
            prevBtn.addEventListener('click', () => this.playPrevious());
        }

        const nextBtn = document.getElementById('nextBtn');
        if (nextBtn) {
            nextBtn.addEventListener('click', () => this.playNext());
        }

        const volumeSlider = document.getElementById('volumeSlider');
        if (volumeSlider) {
            volumeSlider.addEventListener('input', (e) => this.setVolume(e.target.value));
        }

        const seekBar = document.getElementById('seekBar');
        if (seekBar) {
            seekBar.addEventListener('input', (e) => this.seek(e.target.value));
            seekBar.addEventListener('change', (e) => this.seek(e.target.value));
            // Also handle mouse events for better responsiveness
            seekBar.addEventListener('mousedown', () => {
                this.isSeeking = true;
            });
            seekBar.addEventListener('mouseup', () => {
                this.isSeeking = false;
            });
        }

        // Audio element events
        this.audioElement.addEventListener('timeupdate', () => this.updateProgress());
        this.audioElement.addEventListener('ended', () => this.handleTrackEnd());
        this.audioElement.addEventListener('loadedmetadata', () => this.updateDuration());

        // Playlist controls
        const shuffleBtn = document.getElementById('shuffleBtn');
        if (shuffleBtn) {
            shuffleBtn.addEventListener('click', () => this.toggleShuffle());
        }

        const repeatOneBtn = document.getElementById('repeatOneBtn');
        if (repeatOneBtn) {
            repeatOneBtn.addEventListener('click', () => this.toggleRepeatOne());
        }

        const autoScrollBtn = document.getElementById('autoScrollBtn');
        if (autoScrollBtn) {
            autoScrollBtn.addEventListener('click', () => this.toggleAutoScroll());
        }

        // Save/Load buttons
        const saveStateBtn = document.getElementById('saveStateBtn');
        if (saveStateBtn) {
            saveStateBtn.addEventListener('click', () => this.saveToFile());
        }

        const loadStateBtn = document.getElementById('loadStateBtn');
        if (loadStateBtn) {
            loadStateBtn.addEventListener('click', () => this.loadFromFile());
        }

        // Search functionality
        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => this.handleSearch(e.target.value));
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    this.clearSearch();
                }
            });
        }

        const clearSearchBtn = document.getElementById('clearSearch');
        if (clearSearchBtn) {
            clearSearchBtn.addEventListener('click', () => this.clearSearch());
        }

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            // Don't trigger shortcuts when typing in input fields
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
                // Only allow escape key to work in input fields
                if (e.key === 'Escape' && e.target.id === 'searchInput') {
                    this.clearSearch();
                }
                return;
            }

            if (e.ctrlKey && e.key === 's') {
                e.preventDefault();
                this.saveToFile();
            } else if (e.ctrlKey && e.key === 'o') {
                e.preventDefault();
                this.loadFromFile();
            } else if (e.ctrlKey && e.key === 'f') {
                e.preventDefault();
                const searchInput = document.getElementById('searchInput');
                if (searchInput) {
                    searchInput.focus();
                }
            } else if (e.key === ' ') {
                e.preventDefault();
                this.togglePlay();
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                this.playNext();
            } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                this.playPrevious();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                const volumeSlider = document.getElementById('volumeSlider');
                if (volumeSlider) {
                    const newVolume = Math.min(100, parseInt(volumeSlider.value) + 5);
                    volumeSlider.value = newVolume;
                    this.setVolume(newVolume);
                    this.showNotification(`Volume: ${newVolume}%`, 'info', 1000);
                }
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                const volumeSlider = document.getElementById('volumeSlider');
                if (volumeSlider) {
                    const newVolume = Math.max(0, parseInt(volumeSlider.value) - 5);
                    volumeSlider.value = newVolume;
                    this.setVolume(newVolume);
                    this.showNotification(`Volume: ${newVolume}%`, 'info', 1000);
                }
            } else if (e.key === 's' && !e.ctrlKey) {
                e.preventDefault();
                this.toggleShuffle();
            } else if (e.key === 'r' && !e.ctrlKey) {
                e.preventDefault();
                this.toggleRepeatOne();
            } else if (e.key === 'm') {
                e.preventDefault();
                const volumeSlider = document.getElementById('volumeSlider');
                if (volumeSlider) {
                    if (this.audioElement.volume > 0) {
                        this.previousVolume = this.audioElement.volume;
                        this.setVolume(0);
                        volumeSlider.value = 0;
                        this.showNotification('Muted', 'info', 1000);
                    } else {
                        const restoreVolume = (this.previousVolume || 0.5) * 100;
                        this.setVolume(restoreVolume);
                        volumeSlider.value = restoreVolume;
                        this.showNotification(`Volume: ${restoreVolume}%`, 'info', 1000);
                    }
                }
            } else if (e.key === 'Delete') {
                e.preventDefault();
                if (this.selectedFiles.size > 0) {
                    const fileIds = Array.from(this.selectedFiles);
                    fileIds.forEach(fileId => this.deleteFile(fileId));
                }
            }
        });

        console.log('Event listeners setup complete');
    }

    handleSearch(query) {
        this.searchQuery = query.toLowerCase().trim();
        const clearSearchBtn = document.getElementById('clearSearch');

        if (this.searchQuery) {
            clearSearchBtn.style.display = 'flex';
            this.filterFiles();
        } else {
            clearSearchBtn.style.display = 'none';
            this.filteredFiles.clear();
        }

        this.updateFilesList();
    }

    filterFiles() {
        this.filteredFiles.clear();
        const folderFiles = this.folders.get(this.currentFolder).files;

        folderFiles.forEach(fileId => {
            const file = this.files.get(fileId);
            if (file && file.name.toLowerCase().includes(this.searchQuery)) {
                this.filteredFiles.add(fileId);
            }
        });
    }

    clearSearch() {
        const searchInput = document.getElementById('searchInput');
        const clearSearchBtn = document.getElementById('clearSearch');

        searchInput.value = '';
        this.searchQuery = '';
        this.filteredFiles.clear();
        clearSearchBtn.style.display = 'none';

        this.updateFilesList();
    }

    createDefaultFolder() {
        if (!this.folders.has('all')) {
            this.folders.set('all', {
                name: 'All Files',
                files: new Set()
            });
        }
        this.updateFoldersList();
    }

    updateFoldersList() {
        const foldersContainer = document.getElementById('folders');
        foldersContainer.innerHTML = '';

        // Remove any existing event listeners
        const newContainer = foldersContainer.cloneNode(false);
        newContainer.id = 'folders'; // Ensure the ID is preserved
        foldersContainer.parentNode.replaceChild(newContainer, foldersContainer);

        this.folders.forEach((folder, folderId) => {
            const folderElement = document.createElement('div');
            folderElement.className = `folder-item ${this.currentFolder === folderId ? 'active' : ''}`;
            folderElement.dataset.folderId = folderId;

            folderElement.innerHTML = `
                <div class="folder-name">
                    <span class="material-icons">folder</span>
                    ${escapeHTML(folder.name)}
                </div>
                ${folderId !== 'all' ? `
                    <div class="folder-controls">
                        <button class="folder-btn rename" title="Rename folder">
                            <span class="material-icons">edit</span>
                        </button>
                        <button class="folder-btn delete" title="Delete folder">
                            <span class="material-icons">delete</span>
                        </button>
                    </div>
                ` : ''}
            `;

            newContainer.appendChild(folderElement);
        });

        // Use event delegation for all folder interactions
        newContainer.addEventListener('click', (e) => {
            const folderItem = e.target.closest('.folder-item');
            if (!folderItem) return;

            const folderId = folderItem.dataset.folderId;

            // Handle folder control buttons - check for both button and icon clicks
            const renameBtn = e.target.closest('.folder-btn.rename');
            const deleteBtn = e.target.closest('.folder-btn.delete');

            if (renameBtn) {
                e.stopPropagation();
                e.preventDefault();
                this.renameFolder(folderId);
                return;
            }

            if (deleteBtn) {
                e.stopPropagation();
                e.preventDefault();
                this.deleteFolder(folderId);
                return;
            }

            // Handle folder selection (only if not clicking on controls)
            if (!e.target.closest('.folder-controls')) {
                e.preventDefault();
                e.stopPropagation();
                this.switchFolder(folderId);
            }
        });
    }

    updateFolderActiveStates() {
        const foldersContainer = document.getElementById('folders');
        const folderElements = foldersContainer.querySelectorAll('.folder-item');

        folderElements.forEach(folderElement => {
            const folderId = folderElement.dataset.folderId;
            if (folderId === this.currentFolder) {
                folderElement.classList.add('active');
            } else {
                folderElement.classList.remove('active');
            }
        });
    }

    updateFilesList() {
        const filesGrid = document.getElementById('filesGrid');
        filesGrid.innerHTML = '';

        // Add toolbar for multi-select operations
        const toolbar = document.createElement('div');
        toolbar.className = 'files-toolbar';
        toolbar.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 16px;
            background: #1a1a1a;
            border-radius: 8px;
            margin: 8px;
        `;

        const selectionTools = document.createElement('div');
        selectionTools.style.cssText = `
            display: flex;
            gap: 8px;
            align-items: center;
        `;



        const clearAllBtn = document.createElement('button');
        clearAllBtn.innerHTML = '<span class="material-icons">cleaning_services</span> Clear All';
        clearAllBtn.className = 'toolbar-btn';
        clearAllBtn.style.cssText = `
            background: #666;
            color: white;
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 4px;
            font-size: 14px;
        `;

        selectionTools.appendChild(clearAllBtn);
        toolbar.appendChild(selectionTools);
        filesGrid.appendChild(toolbar);

        // Use filtered files if search is active, otherwise use all folder files
        const folderFiles = this.folders.get(this.currentFolder).files;
        const filesToShow = this.searchQuery ? this.filteredFiles : folderFiles;

        // Show search results info
        if (this.searchQuery) {
            const searchInfo = document.createElement('div');
            searchInfo.style.cssText = `
                padding: 12px 16px;
                background: rgba(139, 92, 246, 0.1);
                border: 1px solid rgba(139, 92, 246, 0.3);
                border-radius: 8px;
                margin: 8px;
                color: #a0a0a0;
                font-size: 14px;
            `;
            searchInfo.innerHTML = `
                <span class="material-icons" style="vertical-align: middle; margin-right: 8px; font-size: 18px;">search</span>
                Found ${filesToShow.size} result${filesToShow.size !== 1 ? 's' : ''} for "${escapeHTML(this.searchQuery)}"
            `;
            filesGrid.appendChild(searchInfo);
        }

        filesToShow.forEach(fileId => {
            const file = this.files.get(fileId);
            if (!file) return;

            const fileElement = document.createElement('div');
            fileElement.className = `file-card ${this.currentTrack === fileId ? 'playing' : ''} ${this.selectedFiles.has(fileId) ? 'selected' : ''}`;
            fileElement.dataset.fileId = fileId;
            fileElement.innerHTML = `
                <div class="file-content">
                    <div class="file-info">
                        <span class="material-icons">audio_file</span>
                        <p>${escapeHTML(file.name)}</p>
                    </div>
                    <button class="delete-btn" title="Delete file">
                        <span class="material-icons">delete</span>
                    </button>
                </div>
            `;

            // Add click handler for selection
            fileElement.addEventListener('click', (e) => {
                if (e.ctrlKey || e.metaKey) {
                    // Toggle selection
                    if (this.selectedFiles.has(fileId)) {
                        this.selectedFiles.delete(fileId);
                        fileElement.classList.remove('selected');
                    } else {
                        this.selectedFiles.add(fileId);
                        fileElement.classList.add('selected');
                    }
                } else if (e.shiftKey && this.lastSelectedFile) {
                    // Range selection
                    const fileElements = Array.from(filesGrid.querySelectorAll('.file-card'));
                    const lastIndex = fileElements.findIndex(el => el.dataset.fileId === this.lastSelectedFile);
                    const currentIndex = fileElements.findIndex(el => el.dataset.fileId === fileId);
                    const start = Math.min(lastIndex, currentIndex);
                    const end = Math.max(lastIndex, currentIndex);

                    for (let i = start; i <= end; i++) {
                        const el = fileElements[i];
                        const id = el.dataset.fileId;
                        this.selectedFiles.add(id);
                        el.classList.add('selected');
                    }
                } else {
                    // Single selection
                    if (!e.target.closest('.delete-btn')) {
                        this.selectedFiles.clear();
                        filesGrid.querySelectorAll('.file-card').forEach(card => card.classList.remove('selected'));
                        this.selectedFiles.add(fileId);
                        fileElement.classList.add('selected');
                        this.playFile(fileId);
                    }
                }

                this.lastSelectedFile = fileId;
            });

            // Add click handler for delete button
            fileElement.querySelector('.delete-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                this.deleteFile(fileId);
            });

            filesGrid.appendChild(fileElement);
        });

        // Add handlers for toolbar buttons
        clearAllBtn.addEventListener('click', () => {
            if (confirm('Are you sure you want to clear all files and folders? This cannot be undone.')) {
                this.clearAll();
            }
        });
    }

    async playFile(fileId, { history = true } = {}) {
        const token = this.playRequest = (this.playRequest || 0) + 1;
        try {
            const file = this.files.get(fileId);
            if (!file) return;
            const url = await this.ensureAudioURL(fileId);
            if (token !== this.playRequest) return;
            const previous = this.currentTrack;
            this.pendingResume = previous === fileId ? (this.resumePosition || 0) : 0;
            this.resumePosition = 0;
            if (history && previous && previous !== fileId) (this.playHistory ||= []).push(previous);
            this.currentTrack = fileId;
            this.audioElement.src = url;
            if (previous && previous !== fileId) {
                const old = this.files.get(previous);
                if (old?.url) { this.cleanupObjectURL(old.url); delete old.url; }
            }
            document.getElementById('currentTrack').textContent = file.name;
            this.selectedFiles = new Set([fileId]);
            this.lastSelectedFile = fileId;
            if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: file.name });
            this.play();
            this.updateFilesList();
            if (this.isAutoScrollOn) setTimeout(() => this.scrollToCurrentTrack(), 0);
        } catch (error) { this.showNotification(`Unable to play track: ${error.message}`, 'error'); }
    }

    togglePlay() {
        if (this.isPlaying) {
            this.pause();
        } else {
            this.play();
        }
    }

    play() {
        if (!this.audioElement.src && this.currentTrack) return this.playFile(this.currentTrack, { history: false });
        if (!this.audioElement.src) return;
        if (!this.audioContext) {
            this.initializeAudioContext();
        }
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }

        this.audioElement.play()
            .then(() => {
                this.isPlaying = true;
                document.getElementById('playBtn').innerHTML = '<span class="material-icons">pause</span>';
            })
            .catch(error => {
                console.error('Error playing audio:', error);
                this.showNotification(`Playback failed: ${error.message}`, 'error');
                this.isPlaying = false;
                document.getElementById('playBtn').innerHTML = '<span class="material-icons">play_arrow</span>';
            });
    }

    pause() {
        this.audioElement.pause();
        this.isPlaying = false;
        document.getElementById('playBtn').innerHTML = '<span class="material-icons">play_arrow</span>';
    }

    playPrevious() {
        if (!this.currentTrack) return;
        while (this.playHistory?.length) {
            const id = this.playHistory.pop();
            if (this.files.has(id)) return this.playFile(id, { history: false });
        }
        const files = Array.from(this.folders.get(this.currentFolder)?.files || []);
        if (files.length) this.playFile(files[(files.indexOf(this.currentTrack) - 1 + files.length) % files.length], { history: false });
    }

    playNext() {
        if (!this.currentTrack) return;

        const files = Array.from(this.folders.get(this.currentFolder).files);
        if (files.length === 0) return;

        if (this.isShuffleOn) {
            this.playRandomTrack();
            return;
        }

        const currentIndex = files.indexOf(this.currentTrack);
        const nextIndex = (currentIndex + 1) % files.length;
        this.playFile(files[nextIndex]);
    }

    setVolume(value) {
        this.audioElement.volume = value / 100;
    }

    seek(value) {
        try {
            if (!this.audioElement.duration || isNaN(this.audioElement.duration)) {
                this.showNotification('Cannot seek: no audio loaded', 'error');
                return;
            }
            const time = (value * this.audioElement.duration) / 100;
            if (time < 0 || time > this.audioElement.duration) {
                this.showNotification('Invalid seek position', 'error');
                return;
            }
            this.audioElement.currentTime = time;
        } catch (error) {
            this.showNotification(`Seek failed: ${error.message}`, 'error');
        }
    }

    updateProgress() {
        if (!this.audioElement.duration || isNaN(this.audioElement.duration)) {
            return; // Can't update progress if no audio is loaded or duration is invalid
        }
        const progress = (this.audioElement.currentTime / this.audioElement.duration) * 100;
        const seekBar = document.getElementById('seekBar');
        // Only update seek bar if user is not currently seeking
        if (seekBar && !this.isSeeking) {
            seekBar.value = progress || 0;
        }
        const currentTimeEl = document.getElementById('currentTime');
        if (currentTimeEl) {
            currentTimeEl.textContent = this.formatTime(this.audioElement.currentTime || 0);
        }
    }

    updateDuration() {
        const durationEl = document.getElementById('duration');
        if (durationEl) {
            durationEl.textContent = this.formatTime(this.audioElement.duration || 0);
        }
    }

    formatTime(seconds) {
        if (!seconds || isNaN(seconds)) {
            return '0:00';
        }
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = Math.floor(seconds % 60);
        return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
    }

    toggleShuffle() {
        this.isShuffleOn = !this.isShuffleOn;

        // If shuffle is being turned on, turn off repeat
        if (this.isShuffleOn && this.isRepeatOneOn) {
            this.isRepeatOneOn = false;
            document.getElementById('repeatOneBtn').classList.remove('active');
        }

        document.getElementById('shuffleBtn').classList.toggle('active', this.isShuffleOn);
        this.saveState();
    }

    toggleRepeatOne() {
        this.isRepeatOneOn = !this.isRepeatOneOn;

        // If repeat is being turned on, turn off shuffle
        if (this.isRepeatOneOn && this.isShuffleOn) {
            this.isShuffleOn = false;
            document.getElementById('shuffleBtn').classList.remove('active');
        }

        document.getElementById('repeatOneBtn').classList.toggle('active', this.isRepeatOneOn);
        this.saveState();
    }

    toggleAutoScroll() {
        this.isAutoScrollOn = !this.isAutoScrollOn;
        document.getElementById('autoScrollBtn').classList.toggle('active', this.isAutoScrollOn);
        this.saveState();

        // If auto-scroll is being turned on and there's a current track, scroll to it
        if (this.isAutoScrollOn && this.currentTrack) {
            this.scrollToCurrentTrack();
        }
    }

    scrollToCurrentTrack() {
        if (!this.currentTrack) return;

        const filesGrid = document.getElementById('filesGrid');
        const currentTrackElement = filesGrid.querySelector(`[data-file-id="${this.currentTrack}"]`);

        if (currentTrackElement) {
            currentTrackElement.scrollIntoView({
                behavior: 'smooth',
                block: 'center',
                inline: 'nearest'
            });
        }
    }

    handleTrackEnd() {
        if (this.isRepeatOneOn) {
            this.audioElement.currentTime = 0;
            this.play();
        } else if (this.isShuffleOn) {
            this.playRandomTrack();
        } else {
            this.playNext();
        }
    }

    playRandomTrack() {
        const candidates = Array.from(this.folders.get(this.currentFolder)?.files || []).filter(id => id !== this.currentTrack);
        if (!candidates.length) return;
        const folderKey = this.currentFolder + ':' + Array.from(this.folders.get(this.currentFolder).files).sort().join(',');
        if (this.shuffleKey !== folderKey || !this.shuffleBag?.length) {
            this.shuffleBag = candidates.slice();
            for (let i = this.shuffleBag.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [this.shuffleBag[i], this.shuffleBag[j]] = [this.shuffleBag[j], this.shuffleBag[i]];
            }
            this.shuffleKey = folderKey;
        }
        this.playFile(this.shuffleBag.pop());
    }

    showInputDialog(title, placeholder = '', initialValue = '') {
        return new Promise((resolve) => {
            // Create backdrop
            const backdrop = document.createElement('div');
            backdrop.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.7);
                z-index: 9999;
                display: flex;
                align-items: center;
                justify-content: center;
            `;

            // Create dialog
            const dialog = document.createElement('div');
            dialog.style.cssText = `
                background: rgba(30, 30, 30, 0.98);
                color: white;
                padding: 24px;
                border-radius: 8px;
                min-width: 300px;
                max-width: 500px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.5);
                border: 1px solid rgba(255, 255, 255, 0.1);
            `;

            dialog.innerHTML = `
                <h3 style="margin-top: 0; margin-bottom: 16px; color: white;">${escapeHTML(title)}</h3>
                <input type="text" value="${escapeHTML(initialValue)}" placeholder="${escapeHTML(placeholder)}"
                    style="width: 100%; padding: 12px; border-radius: 4px; border: 1px solid #444;
                    background: #222; color: white; margin-bottom: 16px; font-size: 14px;
                    outline: none; box-sizing: border-box;">
                <div style="display: flex; justify-content: flex-end; gap: 8px;">
                    <button class="cancel-btn"
                        style="padding: 10px 20px; border-radius: 4px; border: none;
                        background: #666; color: white; cursor: pointer; font-size: 14px;">Cancel</button>
                    <button class="confirm-btn"
                        style="padding: 10px 20px; border-radius: 4px; border: none;
                        background: #2196f3; color: white; cursor: pointer; font-size: 14px;">OK</button>
                </div>
            `;

            backdrop.appendChild(dialog);

            const input = dialog.querySelector('input');

            const cleanup = () => {
                if (backdrop.parentNode) {
                    document.body.removeChild(backdrop);
                }
            };

            dialog.querySelector('.cancel-btn').addEventListener('click', () => {
                cleanup();
                resolve(null);
            });

            dialog.querySelector('.confirm-btn').addEventListener('click', () => {
                const value = input.value.trim();
                cleanup();
                resolve(value || null);
            });

            input.addEventListener('keyup', (e) => {
                if (e.key === 'Enter') {
                    const value = input.value.trim();
                    cleanup();
                    resolve(value || null);
                } else if (e.key === 'Escape') {
                    cleanup();
                    resolve(null);
                }
            });

            // Close on backdrop click
            backdrop.addEventListener('click', (e) => {
                if (e.target === backdrop) {
                    cleanup();
                    resolve(null);
                }
            });

            document.body.appendChild(backdrop);

            // Focus the input after a short delay to ensure it's rendered
            setTimeout(() => {
                input.focus();
                input.select();
            }, 10);
        });
    }

    async createNewFolder() {
        console.log('Creating new folder...');
        const folderName = await this.showInputDialog('Create New Folder', 'Enter folder name');
        console.log('Folder name:', folderName);

        if (folderName) {
            const folderId = 'folder_' + Date.now();
            console.log('Creating folder with ID:', folderId);

            this.folders.set(folderId, {
                name: folderName,
                files: new Set()
            });

            console.log('Current folders:', this.folders);
            this.updateFoldersList();
            this.switchFolder(folderId);
            this.saveState();
        }
    }

    async renameFolder(folderId) {
        const folder = this.folders.get(folderId);
        if (!folder || folderId === 'all') return;

        const newName = await this.showInputDialog('Rename Folder', 'Enter new folder name', folder.name);
        if (newName && newName !== folder.name) {
            folder.name = newName;
            this.updateFoldersList();
            if (this.currentFolder === folderId) {
                document.getElementById('currentFolderName').textContent = folder.name;
            }
            this.saveState();
        }
    }

    deleteFolder(folderId) {
        if (folderId === 'all') return;

        const folder = this.folders.get(folderId);
        if (!folder) return;

        if (confirm(`Are you sure you want to delete the folder "${folder.name}"?`)) {
            // Move files to "All Files" if they're not already there
            folder.files.forEach(fileId => {
                this.folders.get('all').files.add(fileId);
            });

            // Delete the folder
            this.folders.delete(folderId);

            // Switch to "All Files" if the deleted folder was current
            if (this.currentFolder === folderId) {
                this.switchFolder('all');
            } else {
                this.updateFoldersList();
            }
            this.saveState();
        }
    }

    switchFolder(folderId) {
        this.currentFolder = folderId;
        const folder = this.folders.get(folderId);
        if (folder) {
            document.getElementById('currentFolderName').textContent = folder.name;
            // Clear search when switching folders
            this.clearSearch();
            // Update folder active states without recreating the entire list
            this.updateFolderActiveStates();
            this.updateFilesList();
            // Save the current folder selection
            this.saveState();
        }
    }

    deleteFile(fileId) {
        const file = this.files.get(fileId);
        if (!file) return;

        if (confirm(`Are you sure you want to delete "${file.name}"?`)) {
            // Remove from all folders
            this.folders.forEach(folder => {
                folder.files.delete(fileId);
            });

            // Cleanup blob URL to prevent memory leak
            if (file.url) {
                this.cleanupObjectURL(file.url);
            }

            // Remove from files map
            this.files.delete(fileId);

            // Remove from IndexedDB
            const transaction = this.db.transaction(['files'], 'readwrite');
            const store = transaction.objectStore('files');
            store.delete(fileId);

            // If this was the current track, stop playback
            if (this.currentTrack === fileId) {
                this.audioElement.pause();
                this.audioElement.src = '';
                this.currentTrack = null;
                this.isPlaying = false;
                document.getElementById('currentTrack').textContent = 'No track selected';
                document.getElementById('playBtn').innerHTML = '<span class="material-icons">play_arrow</span>';
            }

            // Update the display
            this.updateFilesList();
            this.saveState();
        }
    }

    async showLoadingDialog(message) {
        const dialog = document.createElement('div');
        dialog.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(30, 30, 30, 0.95);
            color: white;
            padding: 20px;
            border-radius: 8px;
            z-index: 1000;
            min-width: 300px;
            text-align: center;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        `;

        const messageEl = document.createElement('div');
        messageEl.textContent = message;
        messageEl.style.marginBottom = '15px';
        dialog.appendChild(messageEl);

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = `
            background: #ff4444;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            transition: background 0.2s;
        `;
        cancelBtn.onmouseover = () => cancelBtn.style.background = '#ff6666';
        cancelBtn.onmouseout = () => cancelBtn.style.background = '#ff4444';
        dialog.appendChild(cancelBtn);

        document.body.appendChild(dialog);

        return {
            dialog,
            messageEl,
            cancelBtn,
            updateMessage: (text) => messageEl.textContent = text
        };
    }

    async saveToFile() {
        let abortController = new AbortController();
        let loadingDialog = null;

        try {
            // Show save dialog immediately
            const result = await window.electronAPI.showSaveDialog({
                title: 'Save Library',
                defaultPath: 'soundplayer-library.zip',
                filters: [
                    { name: 'ZIP Files', extensions: ['zip'] }
                ]
            });

            if (!result) return; // User cancelled
            const savePath = result;

            loadingDialog = await this.showLoadingDialog('Preparing library for download...');
            loadingDialog.cancelBtn.addEventListener('click', () => {
                abortController.abort();
                document.body.removeChild(loadingDialog.dialog);
                alert('Save operation cancelled');
            });

            // Get unique file IDs from all folders
            const uniqueFileIds = new Set();
            this.folders.forEach(folder => {
                folder.files.forEach(fileId => uniqueFileIds.add(fileId));
            });

            // Prepare the metadata
            const metadata = {
                folders: Array.from(this.folders.entries()).map(([id, folder]) => ({
                    id,
                    name: folder.name,
                    files: Array.from(folder.files || [])
                })),
                fileInfo: []
            };

            // Create zip file
            const zip = new JSZip();
            zip.file('metadata.json', JSON.stringify(metadata, null, 2));

            let processed = 0;
            const total = uniqueFileIds.size;
            if (total > 20000) throw new Error('Library exceeds the 20,000-track restore limit');
            let uncompressedBytes = 0;
            console.log(`Saving ${total} unique files...`);

            for (const fileId of uniqueFileIds) {
                if (abortController.signal.aborted) {
                    throw new Error('Operation cancelled');
                }

                try {
                    const fileInfo = this.files.get(fileId);
                    if (!fileInfo) {
                        throw new Error('Track metadata is missing');
                    }

                    processed++;
                    loadingDialog.updateMessage(`Preparing library for download... (${processed}/${total} files)`);

                    const fileData = await this.getFile(fileId);
                    if (!fileData) throw new Error('Stored audio is missing');
                    const bytes = fileData.size ?? fileData.byteLength;
                    uncompressedBytes += bytes;
                    if (bytes > 512 * 1024 ** 2 || uncompressedBytes > 2 * 1024 ** 3) throw new Error('Library exceeds the documented restore size limits');
                    if (fileData) {
                        zip.file(fileId, fileData instanceof Blob ? await fileData.arrayBuffer() : fileData);
                        metadata.fileInfo.push({
                            id: fileId,
                            name: fileInfo.name
                        });
                    }
                } catch (err) {
                    if (abortController.signal.aborted) throw err;
                    throw new Error(`Could not export track: ${err.message}`);
                }
            }

            zip.file('metadata.json', JSON.stringify(metadata, null, 2));

            loadingDialog.updateMessage('Compressing library...');
            const content = await zip.generateAsync({
                type: 'arraybuffer',
                compression: 'STORE',
                compressionOptions: {
                    level: 5
                }
            }, (metadata) => {
                if (abortController.signal.aborted) throw new Error('Operation cancelled');
                loadingDialog.updateMessage(`Compressing library... ${metadata.percent.toFixed(0)}%`);
            });

            if (content.byteLength > 2 * 1024 ** 3) throw new Error('ZIP archive exceeds the 2 GB library limit');
            // Save using Electron
            await window.electronAPI.saveFile(savePath, content);

            document.body.removeChild(loadingDialog.dialog);
            this.showNotification('Library saved successfully', 'success');
        } catch (err) {
            if (loadingDialog && loadingDialog.dialog.parentNode) {
                document.body.removeChild(loadingDialog.dialog);
            }
            if (err.message !== 'Operation cancelled') {
                console.error('Failed to save library:', err);
                alert('Failed to save library: ' + err.message);
            }
        }
    }

    async getFile(fileId) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['files'], 'readonly');
            const store = transaction.objectStore('files');
            const request = store.get(fileId);

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async loadFromFile() {
        if (this.libraryBusy) return;
        this.libraryBusy = true;
        document.querySelector('.app-container').inert = true;
        const staged = [];
        let loading;
        try {
            const filePath = await window.electronAPI.showOpenDialog();
            if (!filePath) return;
            loading = await this.showLoadingDialog('Validating library…');
            let cancelled = false;
            loading.cancelBtn.addEventListener('click', () => { cancelled = true; });
            const zip = await JSZip.loadAsync(await window.electronAPI.loadFile(filePath));
            const entry = zip.file('metadata.json');
            if (!entry || entry._data?.uncompressedSize > 5 * 1024 ** 2) throw new Error('Invalid library metadata');
            const metadata = JSON.parse(await entry.async('string'));
            if (!Array.isArray(metadata.folders) || !Array.isArray(metadata.fileInfo) || metadata.fileInfo.length > 20000) throw new Error('Invalid library structure');
            const ids = new Set();
            let total = 0;
            for (const file of metadata.fileInfo) {
                if (typeof file.id !== 'string' || !file.id || typeof file.name !== 'string' || ids.has(file.id)) throw new Error('Invalid or duplicate track');
                const audio = zip.file(file.id);
                if (!audio || audio._data?.uncompressedSize > 512 * 1024 ** 2) throw new Error('Missing or oversized audio entry');
                total += audio._data?.uncompressedSize || 0;
                if (total > 2 * 1024 ** 3) throw new Error('Library expands beyond 2 GB');
                ids.add(file.id);
            }
            const folderIds = new Set();
            for (const folder of metadata.folders) {
                if (typeof folder.id !== 'string' || folderIds.has(folder.id) || typeof folder.name !== 'string' || !Array.isArray(folder.files) || folder.files.some(id => !ids.has(id))) throw new Error('Invalid folder metadata');
                folderIds.add(folder.id);
            }
            const mapping = new Map();
            const files = [];
            for (const file of metadata.fileInfo) {
                if (cancelled) throw new Error('Operation cancelled');
                const id = crypto.randomUUID();
                const blob = await zip.file(file.id).async('blob');
                await this.storeFile(id, blob);
                staged.push(id);
                mapping.set(file.id, id);
                files.push({ id, name: file.name, size: blob.size });
                loading.updateMessage(`Loading library (${files.length}/${metadata.fileInfo.length})…`);
            }
            if (cancelled) throw new Error('Operation cancelled');
            const folders = metadata.folders.map(folder => ({ id: folder.id, name: folder.name, files: folder.files.map(id => mapping.get(id)) }));
            const all = folders.find(folder => folder.id === 'all');
            if (all) all.files = files.map(file => file.id);
            else folders.unshift({ id: 'all', name: 'All Files', files: files.map(file => file.id) });
            // Commit state replacement and old audio removal together; failure keeps the previous library intact.
            const transaction = this.db.transaction(['files', 'state'], 'readwrite');
            const oldFiles = transaction.objectStore('files');
            for (const id of this.files.keys()) oldFiles.delete(id);
            transaction.objectStore('state').put({ folders, files, currentFolder: 'all', currentTrack: null, volume: this.audioElement.volume }, 'currentState');
            await new Promise((resolve, reject) => {
                transaction.oncomplete = resolve;
                transaction.onabort = () => reject(transaction.error || new Error('Restore transaction aborted'));
                transaction.onerror = () => reject(transaction.error);
            });
            staged.length = 0;
            this.audioElement.pause();
            this.audioElement.removeAttribute('src');
            this.audioElement.load();
            this.isPlaying = false;
            document.getElementById('playBtn').innerHTML = '<span class="material-icons">play_arrow</span>';
            await this.loadState();
            this.showNotification('Library restored successfully', 'success');
        } catch (error) {
            for (const id of staged) {
                const tx = this.db.transaction('files', 'readwrite');
                tx.objectStore('files').delete(id);
            }
            if (error.message !== 'Operation cancelled') this.showNotification(`Library not restored: ${error.message}`, 'error');
        } finally { loading?.dialog.remove(); this.libraryBusy = false; document.querySelector('.app-container').inert = false; }
    }

    async clearDatabase() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['files'], 'readwrite');
            const store = transaction.objectStore('files');
            const request = store.clear();

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async storeFile(fileId, fileData) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction('files', 'readwrite');
            transaction.objectStore('files').put(fileData, fileId);
            transaction.oncomplete = resolve;
            transaction.onabort = () => reject(transaction.error || new Error('Audio storage failed'));
            transaction.onerror = () => reject(transaction.error);
        });
    }

    arrayBufferToBase64(buffer) {
        return new Promise((resolve) => {
            const blob = new Blob([buffer]);
            const reader = new FileReader();
            reader.onload = () => {
                const dataUrl = reader.result;
                const base64 = dataUrl.split(',')[1];
                resolve(base64);
            };
            reader.readAsDataURL(blob);
        });
    }

    base64ToArrayBuffer(base64) {
        return fetch(`data:application/octet-stream;base64,${base64}`).then(res => res.arrayBuffer());
    }

    async clearAll() {
        const loadingDialog = this.showSimpleLoading('Clearing all data...');

        try {
            // Stop playback
            if (this.isPlaying) {
                this.pause();
            }
            this.currentTrack = null;
            document.getElementById('currentTrack').textContent = 'No track selected';

            // Clear memory and cleanup blob URLs
            this.cleanupAllObjectURLs();
            this.files.clear();
            this.folders.clear();
            this.selectedFiles.clear();

            // Clear IndexedDB
            await this.clearDatabase();

            // Reset to default state
            this.createDefaultFolder();
            this.currentFolder = 'all';

            // Update UI
            this.updateFoldersList();
            this.updateFilesList();

            await this.saveState();
            this.showNotification('All data cleared successfully', 'success');
        } catch (error) {
            this.showNotification(`Failed to clear data: ${error.message}`, 'error');
        } finally {
            // Close loading dialog
            if (document.body.contains(loadingDialog)) {
                document.body.removeChild(loadingDialog);
            }
        }
    }
}

// Initialize the sound player when the page loads
window.addEventListener('load', () => {
    window.soundPlayer = new SoundPlayer();
});
