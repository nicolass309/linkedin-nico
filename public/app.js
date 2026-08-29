// State Management
let posts = [];
let linkedinConfig = { isConnected: false, clientId: '', clientSecret: '', personUrn: '', autoPublishEnabled: true, redirectUri: '' };
let activeTab = 'dashboard';
let selectedPost = null;

// LocalStorage Persistence Keys
const LS_SCHEDULED_KEY = 'nico_linkedin_scheduled_cache_v2';
const LS_PUBLISHED_KEY = 'nico_linkedin_published_cache_v2';

function getLocalScheduled() {
    try {
        return JSON.parse(localStorage.getItem(LS_SCHEDULED_KEY) || '{}');
    } catch (e) {
        return {};
    }
}

function saveLocalScheduled(id, scheduledDate) {
    try {
        const current = getLocalScheduled();
        current[id] = { status: 'scheduled', scheduledDate };
        localStorage.setItem(LS_SCHEDULED_KEY, JSON.stringify(current));
    } catch (e) {}
}

function getLocalPublished() {
    try {
        return JSON.parse(localStorage.getItem(LS_PUBLISHED_KEY) || '[]');
    } catch (e) {
        return [];
    }
}

function saveLocalPublished(id) {
    try {
        const current = getLocalPublished();
        if (!current.includes(id)) {
            current.push(id);
            localStorage.setItem(LS_PUBLISHED_KEY, JSON.stringify(current));
        }
        // Remove from scheduled cache if now published
        const sched = getLocalScheduled();
        if (sched[id]) {
            delete sched[id];
            localStorage.setItem(LS_SCHEDULED_KEY, JSON.stringify(sched));
        }
    } catch (e) {}
}

// DOM Elements
const navItems = document.querySelectorAll('.nav-item');
const tabContents = document.querySelectorAll('.tab-content');
const globalSearch = document.getElementById('global-search');
const btnRefresh = document.getElementById('btn-refresh');
const btnNewPost = document.getElementById('btn-new-post');

// LinkedIn Status elements
const topbarConnectionPill = document.getElementById('topbar-connection-pill');
const topbarConnectionText = document.getElementById('topbar-connection-text');
const sidebarConnectionStatus = document.getElementById('sidebar-connection-status');

// Settings Elements
const settingsClientId = document.getElementById('settings-client-id');
const settingsClientSecret = document.getElementById('settings-client-secret');
const settingsRedirectUri = document.getElementById('settings-redirect-uri');
const settingsToken = document.getElementById('settings-token');
const settingsUrn = document.getElementById('settings-urn');
const settingsAutopublish = document.getElementById('settings-autopublish');
const btnSaveSettings = document.getElementById('btn-save-settings');
const btnOauthLogin = document.getElementById('btn-oauth-login');

// Modal Elements
const modalPost = document.getElementById('modal-post');
const btnCloseModal = document.getElementById('btn-close-modal');
const editTitle = document.getElementById('edit-title');
const editText = document.getElementById('edit-text');
const editCategory = document.getElementById('edit-category');
const editImage = document.getElementById('edit-image');
const editDate = document.getElementById('edit-date');
const scheduledDateGroup = document.getElementById('scheduled-date-group');
const mockupPostText = document.getElementById('mockup-post-text');
const mockupImage = document.getElementById('mockup-image');
const mockupMediaContainer = document.getElementById('mockup-media-container');

// Modal Action Buttons
const btnDeletePost = document.getElementById('btn-delete-post');
const btnSaveDraft = document.getElementById('btn-save-draft');
const btnApprovePost = document.getElementById('btn-approve-post');
const btnPublishHelper = document.getElementById('btn-publish-helper');
const btnPublishApi = document.getElementById('btn-publish-api');

// Toast Container
const toastContainer = document.getElementById('toast-container');

// Initialize Dashboard
document.addEventListener('DOMContentLoaded', () => {
    fetchPosts();
    fetchConfig();
    setupEventListeners();
    checkUrlQueryParams();
});

// Check URL query parameters for OAuth status redirects
function checkUrlQueryParams() {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('linkedin_connected')) {
        showToast('🚀 ¡Conectado exitosamente con tu cuenta de LinkedIn!', 'success');
        window.history.replaceState({}, document.title, window.location.pathname);
    } else if (urlParams.has('oauth_error')) {
        showToast('💡 Ve a Conexión LinkedIn y haz clic en "Conectar con LinkedIn (1 Clic)"', 'warning');
        window.history.replaceState({}, document.title, window.location.pathname);
    }
}

// Fetch all posts from API and synchronize local cache
async function fetchPosts() {
    try {
        const response = await fetch('/api/posts');
        if (!response.ok) throw new Error('Error al obtener publicaciones');
        posts = await response.json();

        // Check if client has local approvals that the server doesn't know about (e.g. Render restart)
        const localSched = getLocalScheduled();
        const localPub = getLocalPublished();
        let needsSync = false;

        posts.forEach(p => {
            if (p.status === 'draft' && localSched[p.id]) {
                needsSync = true;
            }
            if (p.status !== 'published' && localPub.includes(p.id)) {
                needsSync = true;
            }
        });

        if (needsSync) {
            try {
                const syncRes = await fetch('/api/posts/sync-client', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ scheduledMap: localSched, publishedIds: localPub })
                });
                if (syncRes.ok) {
                    const syncData = await syncRes.json();
                    if (syncData.posts) posts = syncData.posts;
                }
            } catch (syncErr) {
                console.error('Error syncing client cache:', syncErr);
            }
        }

        // Keep local cache updated with published items from server
        posts.forEach(p => {
            if (p.status === 'published') {
                saveLocalPublished(p.id);
            } else if (p.status === 'scheduled' && p.scheduledDate) {
                saveLocalScheduled(p.id, p.scheduledDate);
            }
        });

        renderAll();
    } catch (error) {
        showToast(error.message, 'danger');
    }
}

// Fetch LinkedIn config from API
async function fetchConfig() {
    try {
        const response = await fetch('/api/config');
        if (!response.ok) throw new Error('Error al obtener configuración');
        linkedinConfig = await response.json();
        updateConnectionUI();
    } catch (error) {
        console.error('Error fetching config:', error);
    }
}

// Update LinkedIn Connection Status UI
function updateConnectionUI() {
    const oauthStatusIcon = document.getElementById('oauth-status-icon');
    const oauthStatusLabel = document.getElementById('oauth-status-label');

    if (linkedinConfig.isConnected) {
        topbarConnectionPill.className = 'connection-pill connected';
        topbarConnectionText.innerText = 'LinkedIn Conectado';
        sidebarConnectionStatus.innerText = '🟢';
        if (oauthStatusIcon) oauthStatusIcon.innerText = '🟢';
        if (oauthStatusLabel) oauthStatusLabel.innerText = 'LinkedIn Conectado Exitosamente';
    } else {
        topbarConnectionPill.className = 'connection-pill disconnected';
        topbarConnectionText.innerText = 'LinkedIn Sin Conectar';
        sidebarConnectionStatus.innerText = '🔴';
        if (oauthStatusIcon) oauthStatusIcon.innerText = '🔴';
        if (oauthStatusLabel) oauthStatusLabel.innerText = 'Sin Conectar';
    }
}

// Setup Event Listeners
function setupEventListeners() {
    // Navigation Tabs
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            navItems.forEach(n => n.classList.remove('active'));
            item.classList.add('active');
            
            activeTab = item.getAttribute('data-tab');
            tabContents.forEach(content => {
                content.classList.remove('active');
                if (content.id === `tab-${activeTab}`) {
                    content.classList.add('active');
                }
            });
            renderAll();
        });
    });

    // Refresh button
    btnRefresh.addEventListener('click', () => {
        fetchPosts();
        fetchConfig();
        showToast('Publicaciones y configuración actualizadas', 'success');
    });

    // New post creation
    btnNewPost.addEventListener('click', () => {
        openModal(null);
    });

    // Modal closing
    btnCloseModal.addEventListener('click', closeModal);
    modalPost.addEventListener('click', (e) => {
        if (e.target === modalPost) closeModal();
    });

    // Live LinkedIn Mockup updates
    editText.addEventListener('input', updateMockup);
    editImage.addEventListener('input', updateMockup);

    // Save as draft
    btnSaveDraft.addEventListener('click', savePostChanges);

    // Approve draft and schedule
    btnApprovePost.addEventListener('click', approveDraft);

    // Publish helper button
    btnPublishHelper.addEventListener('click', publishToLinkedIn);

    // Direct API Publish button
    if (btnPublishApi) {
        btnPublishApi.addEventListener('click', publishViaAPI);
    }

    // Delete post button
    btnDeletePost.addEventListener('click', deletePost);

    // Save settings button
    if (btnSaveSettings) {
        btnSaveSettings.addEventListener('click', saveLinkedInSettings);
    }

    // OAuth 2.0 Login button handler (1-click direct redirect)
    if (btnOauthLogin) {
        btnOauthLogin.addEventListener('click', () => {
            window.location.href = '/auth/linkedin';
        });
    }

    // Global Search filter
    globalSearch.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        renderAll(query);
    });
}

// Save LinkedIn Settings
async function saveLinkedInSettings() {
    const clientId = settingsClientId ? settingsClientId.value.trim() : '';
    const clientSecret = settingsClientSecret ? settingsClientSecret.value.trim() : '';
    const token = settingsToken ? settingsToken.value.trim() : '';
    const urn = settingsUrn ? settingsUrn.value.trim() : '';
    const autopublish = settingsAutopublish ? settingsAutopublish.checked : true;

    const payload = {
        autoPublishEnabled: autopublish,
        linkedinPersonUrn: urn
    };

    if (clientId) payload.linkedinClientId = clientId;
    if (clientSecret) payload.linkedinClientSecret = clientSecret;
    if (token) payload.linkedinAccessToken = token;

    try {
        const response = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) throw new Error('No se pudo guardar la configuración');
        
        showToast('Configuración de LinkedIn guardada correctamente', 'success');
        if (settingsToken) settingsToken.value = '';
        fetchConfig();
    } catch (error) {
        showToast(error.message, 'danger');
    }
}

// Global Render Coordinator
function renderAll(searchQuery = '') {
    const drafts = posts.filter(p => p.status === 'draft');
    const scheduled = posts.filter(p => p.status === 'scheduled');
    const published = posts.filter(p => p.status === 'published');
    
    document.getElementById('drafts-count').innerText = drafts.length;
    document.getElementById('scheduled-count').innerText = scheduled.length;

    let filteredPosts = posts;
    if (searchQuery) {
        filteredPosts = posts.filter(p => 
            p.title.toLowerCase().includes(searchQuery) ||
            p.text.toLowerCase().includes(searchQuery) ||
            p.category.toLowerCase().includes(searchQuery)
        );
    }

    if (activeTab === 'dashboard') {
        renderDashboardTab(drafts, scheduled, published);
    } else if (activeTab === 'drafts') {
        renderDraftsTab(filteredPosts.filter(p => p.status === 'draft'));
    } else if (activeTab === 'calendar') {
        renderCalendarTab(filteredPosts.filter(p => p.status !== 'draft'));
    }
}

// Toast Notifications System
function showToast(message, type = 'primary') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    let icon = '<i class="fa-solid fa-info toast-icon"></i>';
    if (type === 'success') icon = '<i class="fa-solid fa-circle-check toast-icon success"></i>';
    if (type === 'danger') icon = '<i class="fa-solid fa-triangle-exclamation toast-icon danger"></i>';
    if (type === 'warning') icon = '<i class="fa-solid fa-circle-exclamation toast-icon warning"></i>';
    
    toast.innerHTML = `${icon} <span>${message}</span>`;
    toastContainer.appendChild(toast);
    
    setTimeout(() => toast.classList.add('active'), 50);
    
    setTimeout(() => {
        toast.classList.remove('active');
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// ----------------------------------------------------
// TAB RENDERING FUNCTIONS
// ----------------------------------------------------

// 1. Dashboard Tab Render
function renderDashboardTab(drafts, scheduled, published) {
    document.getElementById('stat-drafts').innerText = drafts.length;
    document.getElementById('stat-scheduled').innerText = scheduled.length;
    document.getElementById('stat-published').innerText = published.length;

    const nextDays = scheduled.map(p => new Date(p.scheduledDate).toLocaleDateString('sv-SE'));
    const uniqueDays = [...new Set(nextDays)];
    document.getElementById('stat-days-covered').innerText = uniqueDays.length;

    const nextPostContainer = document.getElementById('next-post-container');
    const nextPostDateText = document.getElementById('next-post-date');

    const sortedScheduled = [...scheduled].sort((a, b) => new Date(a.scheduledDate) - new Date(b.scheduledDate));
    
    if (sortedScheduled.length > 0) {
        const nextPost = sortedScheduled[0];
        const date = new Date(nextPost.scheduledDate);
        const formattedDate = date.toLocaleDateString('es-ES', { 
            weekday: 'long', 
            day: 'numeric', 
            month: 'short', 
            hour: '2-digit', 
            minute: '2-digit' 
        });

        nextPostDateText.innerText = formattedDate;
        nextPostDateText.className = 'badge badge-accent';

        nextPostContainer.innerHTML = `
            <div class="next-post-detail">
                <div class="next-post-info">
                    <h3>${nextPost.title}</h3>
                    <span class="category-tag"><i class="fa-solid fa-tag"></i> ${nextPost.category}</span>
                </div>
                <p class="next-post-excerpt">${nextPost.text.substring(0, 180)}...</p>
                <div class="next-post-actions">
                    <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); openModal('${nextPost.id}')">
                        <i class="fa-solid fa-pen-to-square"></i> Ver / Editar
                    </button>
                    ${linkedinConfig.isConnected ? `
                        <button class="btn btn-primary btn-sm" onclick="event.stopPropagation(); publishDirectViaAPI('${nextPost.id}')">
                            <i class="fa-solid fa-bolt"></i> Publicar con API
                        </button>
                    ` : ''}
                    <button class="btn btn-success btn-sm" onclick="event.stopPropagation(); triggerPublishFlow('${nextPost.id}')">
                        <i class="fa-solid fa-paper-plane"></i> Copiar y Abrir
                    </button>
                </div>
            </div>
        `;
    } else {
        nextPostDateText.innerText = 'Sin programar';
        nextPostDateText.className = 'badge';
        nextPostContainer.innerHTML = `
            <div class="empty-state">
                <i class="fa-solid fa-calendar-minus"></i>
                <p>No tienes publicaciones programadas pendientes.</p>
                <button class="btn btn-primary" onclick="navItems[1].click()" style="margin-top: 10px;">
                    Ver Borradores
                </button>
            </div>
        `;
    }

    const slotDays = {
        1: { el: document.getElementById('slot-mon'), post: null },
        3: { el: document.getElementById('slot-wed'), post: null },
        4: { el: document.getElementById('slot-thu'), post: null },
        5: { el: document.getElementById('slot-fri'), post: null }
    };

    Object.keys(slotDays).forEach(key => {
        if (slotDays[key].el) {
            slotDays[key].el.innerText = 'Libre';
            slotDays[key].el.className = 'day-status free';
            slotDays[key].el.removeAttribute('onclick');
        }
    });

    const today = new Date();
    sortedScheduled.forEach(post => {
        const postDate = new Date(post.scheduledDate);
        const dayOfWeek = postDate.getDay();
        
        if (slotDays[dayOfWeek] && slotDays[dayOfWeek].el) {
            const diffTime = Math.abs(postDate - today);
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            
            if (diffDays <= 7 && !slotDays[dayOfWeek].post) {
                slotDays[dayOfWeek].post = post;
                const formattedTime = postDate.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
                slotDays[dayOfWeek].el.innerText = `Programado (${formattedTime})`;
                slotDays[dayOfWeek].el.className = 'day-status booked';
                slotDays[dayOfWeek].el.onclick = () => openModal(post.id);
            }
        }
    });
}

// 2. Drafts Tab Render
function renderDraftsTab(draftPosts) {
    const container = document.getElementById('drafts-container');
    
    if (draftPosts.length === 0) {
        container.innerHTML = `
            <div class="empty-state" style="grid-column: 1 / -1;">
                <i class="fa-solid fa-file-invoice"></i>
                <h2>Bandeja de borradores vacía</h2>
                <p>Usa la ventana de chat de Antigravity para pedir que genere nuevos posts para LinkedIn y se añadirán aquí automáticamente.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = draftPosts.map(post => `
        <div class="post-card">
            <div class="post-card-banner">
                <img src="${post.image || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=800'}" alt="Header" class="post-card-img" onerror="this.src='https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=800'">
                <span class="post-card-badge">${post.category}</span>
            </div>
            <div class="post-card-content">
                <h3>${post.title}</h3>
                <p class="post-card-excerpt">${post.text}</p>
                <div class="post-card-footer">
                    <div class="post-author">
                        <span class="post-author-name">${post.author}</span>
                        ${post.originalUrl ? `<a href="${post.originalUrl}" target="_blank" class="post-author-orig"><i class="fa-solid fa-arrow-up-right-from-square"></i> Original</a>` : ''}
                    </div>
                    <div class="post-card-actions">
                        <button class="btn-icon" onclick="openModal('${post.id}')" title="Editar borrador">
                            <i class="fa-solid fa-pen"></i>
                        </button>
                        <button class="btn-icon approve" onclick="approvePostDirect('${post.id}')" title="Aprobar y Programar">
                            <i class="fa-solid fa-check"></i>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `).join('');
}

// Helper to render individual timeline card
function renderTimelineItem(post) {
    const date = new Date(post.publishedAt || post.scheduledDate || Date.now());
    const day = date.getDate();
    const month = date.toLocaleDateString('es-ES', { month: 'short' });
    const time = date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    const weekday = date.toLocaleDateString('es-ES', { weekday: 'short' });

    return `
        <div class="timeline-item ${post.status === 'published' ? 'published' : ''}">
            <div class="timeline-date-col">
                <span class="timeline-date-day">${weekday} ${day}</span>
                <span class="timeline-date-month">${month}</span>
                <span class="timeline-date-time">${time}</span>
            </div>
            <div class="timeline-info-col">
                <img src="${post.image || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=800'}" alt="Thumb" class="timeline-post-thumb" onerror="this.src='https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=800'">
                <div class="timeline-text-wrap">
                    <span class="timeline-post-title">${post.title}</span>
                    <div class="timeline-post-category">
                        <span>${post.category}</span>
                        <span class="status-indicator-pill ${post.status}">
                            ${post.status === 'scheduled' ? 'Programado' : 'Publicado'}
                        </span>
                    </div>
                </div>
            </div>
            <div class="timeline-actions-col">
                <button class="btn btn-secondary" onclick="openModal('${post.id}')">
                    <i class="fa-solid fa-eye"></i> Ver / Editar
                </button>
            </div>
        </div>
    `;
}

// 3. Calendar Tab Render
function renderCalendarTab(scheduledAndPublished) {
    const container = document.getElementById('calendar-container');
    const scheduled = scheduledAndPublished
        .filter(p => p.status === 'scheduled')
        .sort((a, b) => new Date(a.scheduledDate) - new Date(b.scheduledDate));
    const published = scheduledAndPublished
        .filter(p => p.status === 'published')
        .sort((a, b) => new Date(b.publishedAt || b.scheduledDate) - new Date(a.publishedAt || a.scheduledDate));

    let html = '';

    // SECTION 1: SCHEDULED POSTS
    html += `
        <div class="calendar-section-header" style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.2rem; padding-bottom: 0.8rem; border-bottom: 1px solid rgba(255, 255, 255, 0.08);">
            <h3 style="font-size: 1.2rem; font-weight: 700; color: #3b82f6; display: flex; align-items: center; gap: 0.6rem;">
                <i class="fa-solid fa-clock"></i> Próximas Publicaciones Programadas (${scheduled.length})
            </h3>
        </div>
    `;

    if (scheduled.length === 0) {
        html += `
            <div style="padding: 1.5rem; background: rgba(255, 255, 255, 0.02); border-radius: 12px; border: 1px dashed rgba(255, 255, 255, 0.1); margin-bottom: 2.5rem; text-align: center; color: var(--text-secondary);">
                <p>No tienes publicaciones programadas pendientes por salir.</p>
            </div>
        `;
    } else {
        html += `<div class="timeline-group" style="margin-bottom: 2.5rem;">` + scheduled.map(renderTimelineItem).join('') + `</div>`;
    }

    // SECTION 2: PUBLISHED POSTS HISTORY
    html += `
        <div class="calendar-section-header" style="display: flex; align-items: center; justify-content: space-between; margin-top: 1rem; margin-bottom: 1.2rem; padding-bottom: 0.8rem; border-bottom: 1px solid rgba(255, 255, 255, 0.08);">
            <h3 style="font-size: 1.2rem; font-weight: 700; color: #10b981; display: flex; align-items: center; gap: 0.6rem;">
                <i class="fa-solid fa-circle-check"></i> Historial de Publicaciones Realizadas (${published.length})
            </h3>
        </div>
    `;

    if (published.length === 0) {
        html += `
            <div style="padding: 1.5rem; background: rgba(255, 255, 255, 0.02); border-radius: 12px; border: 1px dashed rgba(255, 255, 255, 0.1); text-align: center; color: var(--text-secondary);">
                <p>Aún no has realizado publicaciones anteriores.</p>
            </div>
        `;
    } else {
        html += `<div class="timeline-group">` + published.map(renderTimelineItem).join('') + `</div>`;
    }

    container.innerHTML = html;
}

// ----------------------------------------------------
// DRAFT APPROVAL DIRECT ACTION
// ----------------------------------------------------
async function approvePostDirect(id) {
    const post = posts.find(p => p.id === id);
    if (post && post.status === 'published') {
        showToast('Esta publicación ya fue publicada previamente. No se duplicará.', 'warning');
        return;
    }

    try {
        const response = await fetch(`/api/posts/${id}/approve`, { method: 'POST' });
        if (!response.ok) throw new Error('No se pudo aprobar el borrador');
        const approvedPost = await response.json();
        
        // Save to client localStorage cache
        if (approvedPost.scheduledDate) {
            saveLocalScheduled(approvedPost.id, approvedPost.scheduledDate);
        }

        const date = new Date(approvedPost.scheduledDate);
        const formattedDate = date.toLocaleDateString('es-ES', { 
            weekday: 'long', 
            day: 'numeric', 
            month: 'short', 
            hour: '2-digit', 
            minute: '2-digit' 
        });

        showToast(`Post aprobado y programado para el ${formattedDate}`, 'success');
        fetchPosts();
    } catch (error) {
        showToast(error.message, 'danger');
    }
}

// ----------------------------------------------------
// MODAL CONTROLLER
// ----------------------------------------------------
function openModal(id) {
    if (id) {
        selectedPost = posts.find(p => p.id === id);
        editTitle.value = selectedPost.title;
        editText.value = selectedPost.text;
        editCategory.value = selectedPost.category;
        editImage.value = selectedPost.image;
        
        document.getElementById('modal-title-text').innerText = 'Ver / Editar Publicación';
        btnDeletePost.classList.remove('hidden');

        if (selectedPost.status === 'draft') {
            scheduledDateGroup.classList.add('hidden');
            btnApprovePost.classList.remove('hidden');
            btnPublishHelper.classList.add('hidden');
            if (btnPublishApi) btnPublishApi.classList.add('hidden');
            btnSaveDraft.innerText = 'Guardar Borrador';
        } else {
            scheduledDateGroup.classList.remove('hidden');
            if (selectedPost.scheduledDate) {
                const localDate = new Date(selectedPost.scheduledDate);
                const offset = localDate.getTimezoneOffset();
                const adjustedDate = new Date(localDate.getTime() - (offset * 60 * 1000));
                editDate.value = adjustedDate.toISOString().slice(0, 16);
            }
            btnApprovePost.classList.add('hidden');
            btnPublishHelper.classList.remove('hidden');
            
            if (selectedPost.status === 'published') {
                if (btnPublishApi) btnPublishApi.classList.add('hidden');
            } else if (linkedinConfig.isConnected && btnPublishApi) {
                btnPublishApi.classList.remove('hidden');
            } else if (btnPublishApi) {
                btnPublishApi.classList.add('hidden');
            }

            btnSaveDraft.innerText = 'Guardar Cambios';
            
            if (selectedPost.status === 'published') {
                btnPublishHelper.innerHTML = '<i class="fa-solid fa-rotate-left"></i> Asistente de Copiado';
            } else {
                btnPublishHelper.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Asistente de Copiado';
            }
        }
    } else {
        selectedPost = null;
        editTitle.value = '';
        editText.value = '';
        editCategory.value = 'General';
        editImage.value = '';
        editDate.value = '';
        scheduledDateGroup.classList.add('hidden');
        
        document.getElementById('modal-title-text').innerText = 'Crear Nueva Publicación';
        btnDeletePost.classList.add('hidden');
        btnApprovePost.classList.remove('hidden');
        btnPublishHelper.classList.add('hidden');
        if (btnPublishApi) btnPublishApi.classList.add('hidden');
        btnSaveDraft.innerText = 'Guardar como Borrador';
    }

    updateMockup();
    modalPost.classList.add('active');
}

function closeModal() {
    modalPost.classList.remove('active');
    selectedPost = null;
}

// Live Update LinkedIn Card Mockup
function updateMockup() {
    const textVal = editText.value || 'Redactando post de LinkedIn...';
    const imageVal = editImage.value;

    const maxChars = 260;
    if (textVal.length > maxChars) {
        mockupPostText.innerHTML = textVal.substring(0, maxChars).replace(/\n/g, '<br>');
        document.getElementById('mockup-see-more').style.display = 'inline';
    } else {
        mockupPostText.innerHTML = textVal.replace(/\n/g, '<br>');
        document.getElementById('mockup-see-more').style.display = 'none';
    }

    if (imageVal) {
        mockupImage.src = imageVal;
        mockupMediaContainer.classList.remove('hidden');
    } else {
        mockupMediaContainer.classList.add('hidden');
    }
}

// Save edits
async function savePostChanges() {
    const title = editTitle.value.trim() || 'Publicación sin título';
    const text = editText.value.trim();
    const category = editCategory.value.trim() || 'General';
    const image = editImage.value.trim();

    if (!text) {
        showToast('El cuerpo del post no puede estar vacío', 'warning');
        return;
    }

    const payload = { title, text, category, image };

    if (selectedPost && selectedPost.status !== 'draft' && editDate.value) {
        payload.scheduledDate = new Date(editDate.value).toISOString();
    }

    try {
        if (selectedPost) {
            const response = await fetch(`/api/posts/${selectedPost.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!response.ok) throw new Error('Error al actualizar publicación');
            showToast('Publicación guardada con éxito', 'success');
        } else {
            const response = await fetch('/api/posts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...payload, status: 'draft' })
            });
            if (!response.ok) throw new Error('Error al guardar borrador');
            showToast('Borrador creado con éxito', 'success');
        }
        
        closeModal();
        fetchPosts();
    } catch (error) {
        showToast(error.message, 'danger');
    }
}

// Approve post from Modal Editor
async function approveDraft() {
    if (!selectedPost) {
        const title = editTitle.value.trim() || 'Publicación sin título';
        const text = editText.value.trim();
        const category = editCategory.value.trim() || 'General';
        const image = editImage.value.trim();

        if (!text) {
            showToast('El cuerpo del post no puede estar vacío', 'warning');
            return;
        }

        try {
            const response = await fetch('/api/posts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title, text, category, image, status: 'draft' })
            });
            if (!response.ok) throw new Error('Error al guardar borrador');
            const created = await response.json();
            
            approvePostDirect(created.id);
            closeModal();
        } catch (error) {
            showToast(error.message, 'danger');
        }
    } else {
        approvePostDirect(selectedPost.id);
        closeModal();
    }
}

// Delete Post Action
async function deletePost() {
    if (!selectedPost) return;
    
    if (confirm('¿Estás seguro de que deseas eliminar esta publicación permanentemente?')) {
        try {
            const response = await fetch(`/api/posts/${selectedPost.id}`, { method: 'DELETE' });
            if (!response.ok) throw new Error('No se pudo eliminar la publicación');
            showToast('Publicación eliminada correctamente', 'warning');
            closeModal();
            fetchPosts();
        } catch (error) {
            showToast(error.message, 'danger');
        }
    }
}

// ----------------------------------------------------
// LINKEDIN PUBLISHING FLOWS
// ----------------------------------------------------

// Direct API Publishing
async function publishDirectViaAPI(id) {
    const targetId = id || (selectedPost ? selectedPost.id : null);
    if (!targetId) return;

    try {
        showToast('Enviando publicación a la API de LinkedIn...', 'warning');
        const response = await fetch(`/api/posts/${targetId}/publish-api`, { method: 'POST' });
        const data = await response.json();
        
        if (!response.ok) throw new Error(data.error || 'Error al publicar vía API');

        if (data.alreadyPublished) {
            showToast('ℹ️ ' + data.message, 'warning');
        } else {
            showToast('🚀 ¡Publicado exitosamente en tu cuenta de LinkedIn!', 'success');
        }
        
        saveLocalPublished(targetId);
        if (selectedPost) closeModal();
        fetchPosts();
    } catch (error) {
        showToast(error.message, 'danger');
    }
}

function publishViaAPI() {
    if (selectedPost) publishDirectViaAPI(selectedPost.id);
}

// Helper Copy Publishing
async function triggerPublishFlow(id) {
    const post = posts.find(p => p.id === id);
    if (!post) return;
    selectedPost = post;
    publishToLinkedIn();
}

async function publishToLinkedIn() {
    if (!selectedPost) return;

    const textToCopy = selectedPost.text;
    const imageUrl = selectedPost.image;

    try {
        await navigator.clipboard.writeText(textToCopy);
        showToast('Texto copiado al portapapeles. Redirigiendo a LinkedIn...', 'success');

        if (imageUrl) {
            alert(`💡 Instrucción de Imagen:\n\nHemos copiado el texto del post a tu portapapeles.\n\nPara acompañar el post con su imagen:\n1. Abre/Guarda el enlace de imagen que se abrirá en la pestaña contigua.\n2. Pega el texto en LinkedIn e introduce la imagen descargada.`);
            window.open(imageUrl, '_blank');
        }

        setTimeout(() => {
            window.open('https://www.linkedin.com/feed/?shareActive=true', '_blank');
        }, 800);

        const response = await fetch(`/api/posts/${selectedPost.id}/publish`, { method: 'POST' });
        if (!response.ok) throw new Error('No se pudo actualizar el estado a publicado');
        
        saveLocalPublished(selectedPost.id);
        closeModal();
        fetchPosts();
    } catch (error) {
        showToast('Error al copiar el texto: ' + error.message, 'danger');
    }
}
