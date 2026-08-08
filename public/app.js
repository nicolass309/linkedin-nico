// State Management
let posts = [];
let linkedinConfig = { isConnected: false, clientId: '', clientSecret: '', personUrn: '', autoPublishEnabled: true, redirectUri: '' };
let activeTab = 'dashboard';
let selectedPost = null;

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
        showToast('💡 Copia tu Client ID y Client Secret de la pestaña Auth en LinkedIn Developers', 'warning');
        window.history.replaceState({}, document.title, window.location.pathname);
    }
}

// Fetch all posts from API
async function fetchPosts() {
    try {
        const response = await fetch('/api/posts');
        if (!response.ok) throw new Error('Error al obtener publicaciones');
        posts = await response.json();
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
    if (linkedinConfig.isConnected) {
        topbarConnectionPill.className = 'connection-pill connected';
        topbarConnectionText.innerText = 'LinkedIn Conectado';
        sidebarConnectionStatus.innerText = '🟢';
        
        if (settingsToken && linkedinConfig.maskedToken) {
            settingsToken.placeholder = `Token guardado (${linkedinConfig.maskedToken})`;
        }
    } else {
        topbarConnectionPill.className = 'connection-pill disconnected';
        topbarConnectionText.innerText = 'LinkedIn Sin Conectar';
        sidebarConnectionStatus.innerText = '🔴';
    }

    if (settingsClientId && linkedinConfig.clientId) {
        settingsClientId.value = linkedinConfig.clientId;
    }
    if (settingsClientSecret && linkedinConfig.clientSecret) {
        settingsClientSecret.placeholder = `Secret guardado (${linkedinConfig.clientSecret})`;
    }
    if (settingsRedirectUri && linkedinConfig.redirectUri) {
        settingsRedirectUri.value = linkedinConfig.redirectUri;
    }
    if (settingsUrn) {
        settingsUrn.value = linkedinConfig.personUrn || '';
    }
    if (settingsAutopublish) {
        settingsAutopublish.checked = linkedinConfig.autoPublishEnabled;
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

    // OAuth 2.0 Login button handler
    if (btnOauthLogin) {
        btnOauthLogin.addEventListener('click', () => {
            const clientId = (settingsClientId ? settingsClientId.value.trim() : '') || linkedinConfig.clientId;
            const clientSecret = (settingsClientSecret ? settingsClientSecret.value.trim() : '') || linkedinConfig.clientSecret;

            if (!clientId) {
                showToast('Por favor pega tu Client ID de LinkedIn primero', 'warning');
                if (settingsClientId) settingsClientId.focus();
                return;
            }

            // Redirect to backend OAuth login endpoint
            window.location.href = `/auth/linkedin?client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`;
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
    }, 3500);
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
                <p>No tienes publicaciones programadas para esta semana.</p>
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
        slotDays[key].el.innerText = 'Libre';
        slotDays[key].el.className = 'day-status free';
        slotDays[key].el.removeAttribute('onclick');
    });

    const today = new Date();
    sortedScheduled.forEach(post => {
        const postDate = new Date(post.scheduledDate);
        const dayOfWeek = postDate.getDay();
        
        if (slotDays[dayOfWeek]) {
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

// 3. Calendar/Timeline Tab Render
function renderCalendarTab(scheduledPosts) {
    const container = document.getElementById('calendar-container');

    if (scheduledPosts.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fa-solid fa-calendar-days"></i>
                <h2>Calendario de publicación vacío</h2>
                <p>Ve a la sección de borradores y aprueba publicaciones para llenar tu calendario automatizado.</p>
            </div>
        `;
        return;
    }

    const sortedTimeline = [...scheduledPosts].sort((a, b) => {
        if (a.status === b.status) {
            return new Date(a.scheduledDate) - new Date(b.scheduledDate);
        }
        return a.status === 'scheduled' ? -1 : 1;
    });

    container.innerHTML = sortedTimeline.map(post => {
        const date = new Date(post.scheduledDate);
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
                    ${post.status === 'scheduled' ? `
                        ${linkedinConfig.isConnected ? `
                            <button class="btn btn-primary" onclick="publishDirectViaAPI('${post.id}')">
                                <i class="fa-solid fa-bolt"></i> Publicar API
                            </button>
                        ` : ''}
                        <button class="btn btn-success" onclick="triggerPublishFlow('${post.id}')">
                            <i class="fa-solid fa-paper-plane"></i> Copiar
                        </button>
                    ` : ''}
                </div>
            </div>
        `;
    }).join('');
}

// ----------------------------------------------------
// DRAFT APPROVAL DIRECT ACTION
// ----------------------------------------------------
async function approvePostDirect(id) {
    try {
        const response = await fetch(`/api/posts/${id}/approve`, { method: 'POST' });
        if (!response.ok) throw new Error('No se pudo aprobar el borrador');
        const approvedPost = await response.json();
        
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
            
            if (linkedinConfig.isConnected && btnPublishApi) {
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

        showToast('🚀 ¡Publicado exitosamente en tu cuenta de LinkedIn!', 'success');
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
        
        closeModal();
        fetchPosts();
    } catch (error) {
        showToast('Error al copiar el texto: ' + error.message, 'danger');
    }
}
