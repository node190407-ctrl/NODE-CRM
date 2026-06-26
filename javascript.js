'use strict';

const SUPABASE_URL      = 'https://uoacfsdyhlcsvcjdqycl.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVvYWNmc2R5aGxjc3ZjamRxeWNsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0MTg2OTgsImV4cCI6MjA5Nzk5NDY5OH0.1X5FDJMUikuWOputNOYYhLBCr7BqHv_dlT7f_nrY8XM';
const _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function sbGet(key) {
  try {
    const { data, error } = await _sb.from('crm_store').select('value').eq('key', key).maybeSingle();
    if (error) throw error;
    return data ? data.value : null;
  } catch(e) { console.warn('[Supabase] sbGet error:', key, e); return null; }
}

async function sbSet(key, value) {
  try {
    const { error } = await _sb.from('crm_store').upsert({ key, value }, { onConflict: 'key' });
    if (error) throw error;
  } catch(e) { console.warn('[Supabase] sbSet error:', key, e); }
}

/* ═══════════════════════════════════════════════════════════════
   AUTH — Autenticación con roles (Admin / Ventas)
   ═══════════════════════════════════════════════════════════════ */

const AUTH_SESSION_KEY   = 'node_crm_session';
const AUTH_PASSWORDS_KEY = 'node_crm_passwords';
const AUTH_PROFILES_KEY  = 'node_crm_profiles';

/** Estado en memoria */
const AUTH = { isAuth: false, role: null, profileId: null };

/** Vistas permitidas por rol */
const ROLE_VIEWS = {
  admin:     ['dashboard','pipeline','contactos','actividades','configuracion'],
  ventas:    ['dashboard','pipeline','contactos','actividades'],
  venta:     ['pipeline','contactos','actividades'],   // sin dashboard ni configuracion
  prospecto: ['prospecto-form'],
};

/* ═══════════════════════════════════════════════════════════════
   NOTIFICACIONES — STORE POR DESTINATARIO
   Cada rol/perfil tiene su propio "buzón" de notificaciones.
   Clave: node_notif_[destinatario]
   Destinatarios:
     · 'admin'   → todos los admins ven TODO (deals + prospectos)
     · 'ventas'  → director ve TODO (igual que admin)
     · 'venta_[profileId]' → cada vendedor ve solo sus propios deals
   ═══════════════════════════════════════════════════════════════ */

/** Devuelve la clave de localStorage para el buzón de un destinatario */
function notifKey(destinatario) {
  return 'node_notif_' + destinatario;
}

/** Leer notificaciones de un buzón específico */
async function getNotifDe(destinatario) {
  const data = await sbGet(notifKey(destinatario));
  return Array.isArray(data) ? data : [];
}

async function saveNotifDe(destinatario, lista) {
  await sbSet(notifKey(destinatario), lista);
}
/**
 * Acumula una notificación en los buzones correctos según las reglas:
 *  - ADMIN:  recibe TODAS las notificaciones de todos los perfiles
 *  - VENTAS (director): recibe TODAS las notificaciones de todos los perfiles
 *  - VENTA [profileId]: recibe SOLO las notificaciones de sus propios deals/contactos
 *  - Registro de prospecto: va a admin + ventas (nunca a vendedores individuales)
 * @param {string} tipo
 * @param {object} datos
 * @param {object|null} perfilOrigen  — perfil que generó la alerta (vendedor)
 */
async function acumularNotificacionSegmentada(tipo, datos, perfilOrigen) {
  const id       = 'n' + Date.now() + Math.random().toString(36).slice(2, 6);
  const notif    = { id, tipo, datos, perfil: perfilOrigen || null, ts: Date.now(), enviada: false };

  // ── Determinar a quién va ──────────────────────────────────────
  const destinatarios = new Set();

  // 1. Admin y Director (ventas) siempre reciben todo
  destinatarios.add('admin');
  destinatarios.add('ventas');

  // 2. Si hay perfil origen y es un vendedor 'venta', agregar su buzón personal
  if (perfilOrigen && datos._vendedorProfileId) {
    destinatarios.add('venta_' + datos._vendedorProfileId);
  }

  // 3. Notificaciones de prospecto nuevo SOLO van a admin + ventas (ya están)
  //    (si tipo === 'prospecto_nuevo' no hay perfil de vendedor individual)

  // Guardar en cada buzón
 for (const dest of destinatarios) {
  const lista = await getNotifDe(dest);
  lista.unshift(notif);
  if (lista.length > 100) lista.length = 100;
  await saveNotifDe(dest, lista);
}

  // Actualizar badge si el usuario logueado tiene notificaciones nuevas
  actualizarBadge();
}

/** Obtener buzón del usuario ACTUALMENTE logueado */
function getNotifDelUsuarioActual() {
  const role      = AUTH.role;
  const profileId = AUTH.profileId;
  if (role === 'admin')  return getNotifDe('admin');
  if (role === 'ventas') return getNotifDe('ventas');
  if (role === 'venta')  return getNotifDe('venta_' + profileId);
  return [];
}

/** Guardar buzón del usuario actualmente logueado */
function saveNotifDelUsuarioActual(lista) {
  const role      = AUTH.role;
  const profileId = AUTH.profileId;
  if (role === 'admin')  saveNotifDe('admin',  lista);
  if (role === 'ventas') saveNotifDe('ventas', lista);
  if (role === 'venta')  saveNotifDe('venta_' + profileId, lista);
}

/* ── DATOS DE VENTA: cada vendedor tiene su propio espacio ─── */
/**
 * Clave de datos por perfil de vendedor.
 * Permite que cada vendedor (venta) tenga sus propios contactos, deals y actividades.
 */
function vendedorDataKey(profileId) {
  return 'node_venta_data_' + profileId;
}

async function getVendedorData(profileId) {
  const data = await sbGet(vendedorDataKey(profileId));
  return data || { contactos: [], deals: [], actividades: [] };
}

async function saveVendedorData(profileId, data) {
  await sbSet(vendedorDataKey(profileId), data);
}

/* ── Perfiles por rol (fijos ahora, editables en el futuro desde configuración) ── */
const DEFAULT_PROFILES = {
  admin: [
    { id: 'ceo',     nombre: 'CEO NODE',      cargo: 'Director General',        emoji: '👑', tel: '', email: '', pwd: 'ceo'     },
    { id: 'cto',     nombre: 'CTO NODE',      cargo: 'Director de Tecnología',  emoji: '💻', tel: '', email: '', pwd: 'cto'     },
    { id: 'gerente', nombre: 'Gerente NODE',   cargo: 'Gerente de Operaciones',  emoji: '📋', tel: '', email: '', pwd: 'gerente'  },
  ],
  ventas: [
    { id: 'dir_ventas', nombre: 'Director Ventas',  cargo: 'Director Comercial',  emoji: '📈', tel: '', email: '', pwd: 'dir2'  },
    { id: 'supervisor', nombre: 'Supervisor',        cargo: 'Supervisor de Ventas', emoji: '🔍', tel: '', email: '', pwd: 'sup2026'  },
    { id: 'analista',   nombre: 'Analista Ventas',   cargo: 'Analista Comercial',  emoji: '📊', tel: '', email: '', pwd: 'analista2026' },
  ],
  venta: [
    { id: 'vendedor1', nombre: 'Vendedor 1', cargo: 'Ejecutivo de Ventas', emoji: '🎯', tel: '', email: '', pwd: 'venta2026' },
    { id: 'vendedor2', nombre: 'Vendedor 2', cargo: 'Ejecutivo de Ventas', emoji: '🎯', tel: '', email: '', pwd: 'venta2026' },
    { id: 'vendedor3', nombre: 'Vendedor 3', cargo: 'Ejecutivo de Ventas', emoji: '🎯', tel: '', email: '', pwd: 'venta2026' },
  ],
  prospecto: [
    { id: 'nuevo', nombre: 'Nuevo cliente', cargo: 'Prospecto', emoji: '🙋', tel: '', email: '', pwd: ''}
  ],
};

/* ── Perfiles: leer y guardar ── */
async function getProfiles() {
  try {
    const saved = await sbGet(AUTH_PROFILES_KEY);
    if (!saved) return JSON.parse(JSON.stringify(DEFAULT_PROFILES));
    const result = JSON.parse(JSON.stringify(DEFAULT_PROFILES));
    Object.keys(result).forEach(role => {
      if (saved[role]) {
        result[role] = result[role].map(p => {
          const s = saved[role].find(x => x.id === p.id);
          return s ? { ...p, ...s } : p;
        });
      }
    });
    return result;
  } catch { return JSON.parse(JSON.stringify(DEFAULT_PROFILES)); }
}

async function saveProfiles(profiles) {
  await sbSet(AUTH_PROFILES_KEY, profiles);
}

function getProfileById(role, profileId) {
  return DEFAULT_PROFILES[role]?.find(p => p.id === profileId) || null;
}

async function getProfileByIdAsync(role, profileId) {
  const profiles = await getProfiles();
  return profiles[role]?.find(p => p.id === profileId) || null;
}

const DEFAULT_PWD = { admin: 'admin', ventas: 'ventas', venta: 'venta' };

/* ── Contraseñas de rol (legacy — ya no se usan para login pero se mantienen) ── */
async function getPasswords() {
  try {
    const raw = await sbGet(AUTH_PASSWORDS_KEY);
    return raw ? { ...DEFAULT_PWD, ...raw } : { ...DEFAULT_PWD };
  } catch { return { ...DEFAULT_PWD }; }
}

async function persistPasswords(admin, ventas, venta) {
  await sbSet(AUTH_PASSWORDS_KEY, { admin, ventas, venta });
}

/* ── Sesión (sessionStorage: se limpia al cerrar la pestaña) ── */
function restoreSession() {
  try {
    const raw = sessionStorage.getItem(AUTH_SESSION_KEY);
    if (!raw) return false;
    const s = JSON.parse(raw);
    if (!s?.role) return false;
    AUTH.isAuth = true; AUTH.role = s.role; AUTH.profileId = s.profileId || null;
    return true;
  } catch { return false; }
}
function persistSession(role, profileId) {
  sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify({ role, profileId }));
}
function clearSession() { sessionStorage.removeItem(AUTH_SESSION_KEY); }

/* ── Guard ── */
function canAccess(view) {
  if (!AUTH.isAuth) return false;
  return (ROLE_VIEWS[AUTH.role] || []).includes(view);
}

/* ── Login — Paso 1: seleccionar rol y mostrar perfiles ── */
async function loginStep1() {
  const roleEl = document.querySelector('.role-card.active');
  const errEl  = document.getElementById('login-error');
  const role   = roleEl?.dataset.role;

  const showError = (msg) => {
    errEl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> ${msg}`;
    errEl.classList.remove('hidden');
    const card = document.querySelector('.login-card');
    card.classList.add('shake');
    setTimeout(() => card.classList.remove('shake'), 450);
  };

  if (!role) return showError('Selecciona un rol de acceso.');
  errEl.classList.add('hidden');

  // Construir el paso 2: selector de perfil
  const profiles = await getProfiles();
  const step1 = document.getElementById('login-step-1');
  const step2 = document.getElementById('login-step-2');
  const profileGrid = document.getElementById('login-profile-grid');
  const roleBack = document.getElementById('login-role-back');

  // Render de las cards de perfil
  const roleProfiles = profiles[role] || [];
  profileGrid.innerHTML = roleProfiles.map(p => `
    <button class="profile-card" data-profile-id="${p.id}" data-role="${role}"
      role="radio" aria-checked="false">
      <div class="profile-card-avatar">${p.emoji}</div>
      <div class="profile-card-info">
        <div class="profile-card-name">${escapeHTML(p.nombre)}</div>
        <div class="profile-card-cargo">${escapeHTML(p.cargo)}</div>
      </div>
      <span class="role-card-check" aria-hidden="true">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>
      </span>
    </button>
  `).join('');

  // Listeners en las cards de perfil
  profileGrid.querySelectorAll('.profile-card').forEach(card => {
    card.addEventListener('click', () => {
      profileGrid.querySelectorAll('.profile-card').forEach(c => {
        c.classList.remove('active'); c.setAttribute('aria-checked','false');
      });
      card.classList.add('active'); card.setAttribute('aria-checked','true');
      document.getElementById('login-pwd-step2')?.focus();
    });
  });

  // Botón volver
  roleBack.onclick = () => {
    step2.classList.add('hidden');
    step1.classList.remove('hidden');
    document.getElementById('login-pwd-step2').value = '';
    document.getElementById('login-error-step2').classList.add('hidden');
  };

  // Animación de transición
  step1.style.opacity = '0';
  step1.style.transform = 'translateX(-16px)';
  setTimeout(() => {
    step1.classList.add('hidden');
    step1.style.opacity = '';
    step1.style.transform = '';
    step2.classList.remove('hidden');
    step2.style.opacity = '0';
    step2.style.transform = 'translateX(16px)';
    requestAnimationFrame(() => {
      step2.style.transition = 'opacity 240ms ease, transform 240ms ease';
      step2.style.opacity = '1';
      step2.style.transform = 'translateX(0)';
      setTimeout(() => { step2.style.transition = ''; step2.style.transform = ''; }, 250);
    });
  }, 180);
}

/* ── Login — Paso 2: validar contraseña del perfil y entrar ── */
function loginStep2() {
    const selectedCard =
    document.querySelector('#login-profile-grid .profile-card.active');
  if (selectedCard?.dataset.role === 'prospecto') {
    AUTH.isAuth = true;
    AUTH.role      = 'prospecto';
    AUTH.profileId = 'nuevo';
    persistSession('prospecto', 'nuevo');
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    applyRole();
    navigate('prospecto-form');
    return;
  }
  const profileCard = document.querySelector('#login-profile-grid .profile-card.active');
  const pwdEl  = document.getElementById('login-pwd-step2');
  const errEl  = document.getElementById('login-error-step2');
  const profileId = profileCard?.dataset.profileId;
  const role      = profileCard?.dataset.role;
  const pwd       = pwdEl?.value || '';

  const showError = (msg) => {
    errEl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> ${msg}`;
    errEl.classList.remove('hidden');
    const card = document.querySelector('.login-card');
    card.classList.add('shake');
    setTimeout(() => card.classList.remove('shake'), 450);
    if (pwdEl) { pwdEl.value = ''; pwdEl.focus(); }
  };

  if (!profileId) return showError('Selecciona tu perfil de acceso.');
  if (!pwd)       return showError('Ingresa tu contraseña.');

  const profile = getProfileById(role, profileId);
  if (!profile || pwd !== profile.pwd) return showError('Contraseña incorrecta. Intenta de nuevo.');

  // ✅ Éxito
  AUTH.isAuth = true; AUTH.role = role; AUTH.profileId = profileId;
  persistSession(role, profileId);
  errEl.classList.add('hidden');

  // ── Cargar datos del perfil autenticado ──────────────────────
  // CRÍTICO: loadState() DESPUÉS de setear AUTH.role y AUTH.profileId
  // para que vendedores carguen su store privado, no el global.
  loadState();

  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  // Reset login para próxima vez
  document.getElementById('login-step-2').classList.add('hidden');
  document.getElementById('login-step-1').classList.remove('hidden');
  pwdEl.value = '';

  applyRole();
  wireUpButtons();
  setupSearch();
  setupQuickMenu();
  setupKeyboard();
  setupClock();

  const firstView = ROLE_VIEWS[AUTH.role]?.[0] || 'pipeline';
  navigate(firstView);

  // Revisar notificaciones al entrar + cada 30 minutos
  setTimeout(checkNotificaciones, 2000);
  setInterval(checkNotificaciones, 30 * 60 * 1000);
}

// Alias para compatibilidad con el botón original (ya no se usa pero por si acaso)
function login() { loginStep1(); }

/* ── Logout ── */
function logout() {
  AUTH.isAuth = false; AUTH.role = null; AUTH.profileId = null;
  clearSession();
  S.view='dashboard'; S.searchQuery=''; S.filterFuente=''; S.filterActTipo='';
  Object.values(S.charts).forEach(c => c?.destroy?.()); S.charts = {};
  S.sortables.forEach(s => s?.destroy?.()); S.sortables = [];
  document.getElementById('app').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
  // Reset login al paso 1
  document.getElementById('login-step-1')?.classList.remove('hidden');
  document.getElementById('login-step-2')?.classList.add('hidden');
  document.getElementById('login-pwd-step2') && (document.getElementById('login-pwd-step2').value = '');
  document.getElementById('login-pwd-step2') && (document.getElementById('login-pwd-step2').type = 'password');
  document.getElementById('login-error')?.classList.add('hidden');
  document.getElementById('login-error-step2')?.classList.add('hidden');
  document.getElementById('eye-open')?.classList.remove('hidden');
  document.getElementById('eye-closed')?.classList.add('hidden');
}

/* ── Aplicar restricciones de rol a la UI ── */
function applyRole() {
  const role  = AUTH.role;

  // Prospecto: solo ve el formulario, sin sidebar ni topbar
  const sidebar = document.getElementById('sidebar');
  const topbar  = document.getElementById('topbar');
  if (role === 'prospecto') {
    if (sidebar) sidebar.style.display = 'none';
    if (topbar)  topbar.style.display  = 'none';
    document.getElementById('main').style.marginLeft = '0';
    document.getElementById('main').style.width = '100%';
  } else {
    if (sidebar) sidebar.style.display = '';
    if (topbar)  topbar.style.display  = '';
    document.getElementById('main').style.marginLeft = '';
    document.getElementById('main').style.width = '';
  }

  const badge = document.getElementById('role-badge');

  const ROLE_META = {
    admin:  { icon: '👑', label: 'Admin',       cls: 'role-admin'  },
    ventas: { icon: '📈', label: 'Dir. Ventas', cls: 'role-ventas' },
    venta:  { icon: '🎯', label: 'Venta NODE',  cls: 'role-venta'  },
    prospecto: { icon: '🙋', label: 'Prospecto', cls: 'role-venta' },
  };
  const meta = ROLE_META[role] || ROLE_META.ventas;

  // Obtener datos del perfil activo
  const profile = AUTH.profileId ? getProfileById(role, AUTH.profileId) : null;
  const nombre  = profile?.nombre || meta.label;
  const cargo   = profile?.cargo  || '';
  const emoji   = profile?.emoji  || meta.icon;

  // Badge del sidebar
  if (badge) {
    badge.textContent = emoji + ' ' + meta.label;
    badge.className   = 'role-badge ' + meta.cls;
  }

  // Ocultar vistas no permitidas en el nav
  document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
    btn.classList.toggle('hidden', !canAccess(btn.dataset.view));
  });

  // Nombre, cargo y avatar del sidebar
  const nameEl  = document.getElementById('sidebar-user-name');
  const cargoEl = document.getElementById('sidebar-user-cargo');
  const avatarEl = document.getElementById('sidebar-avatar');
  if (nameEl)  nameEl.textContent  = nombre;
  if (cargoEl) cargoEl.textContent = cargo;
  if (avatarEl) avatarEl.textContent = initials(nombre);

  // Datos de contacto en sidebar (tel/email del perfil)
  const telEl   = document.getElementById('sidebar-user-tel');
  const emailEl = document.getElementById('sidebar-user-email');
  if (telEl)   { telEl.textContent   = profile?.tel   || ''; telEl.parentElement?.classList.toggle('hidden', !profile?.tel); }
  if (emailEl) { emailEl.textContent = profile?.email || ''; emailEl.parentElement?.classList.toggle('hidden', !profile?.email); }
}

/* ── Guardar contraseñas (solo admin) ── */
function savePasswords() {
  if (AUTH.role !== 'admin') return;
  const ap = document.getElementById('cfg-pwd-admin')?.value.trim();
  const vp = document.getElementById('cfg-pwd-ventas')?.value.trim();
  if (!ap || !vp)          { toast('Campos requeridos','Rellena las dos contraseñas.','error'); return; }
  if (ap.length < 6 || vp.length < 6) { toast('Contraseña corta','Mínimo 6 caracteres.','error'); return; }
  persistPasswords(ap, vp);
  document.getElementById('cfg-pwd-admin').value  = '';
  document.getElementById('cfg-pwd-ventas').value = '';
  toast('Contraseñas actualizadas','Aplican al próximo inicio de sesión.','success');
}

/* ── Setup del login screen ── */
function setupLoginScreen() {
  // Paso 1 — selección de rol
  document.querySelectorAll('.role-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.role-card').forEach(c => {
        c.classList.remove('active'); c.setAttribute('aria-checked','false');
      });
      card.classList.add('active'); card.setAttribute('aria-checked','true');
    });
  });

  // Botón "Continuar" del paso 1
  document.getElementById('btn-login-step1')?.addEventListener('click', loginStep1);

  // Botón "Ingresar" del paso 2
  document.getElementById('btn-login-step2')?.addEventListener('click', loginStep2);

  // Enter en el campo de contraseña del paso 2
  document.getElementById('login-pwd-step2')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') loginStep2();
    else document.getElementById('login-error-step2')?.classList.add('hidden');
  });

  // Toggle ojo en contraseña del paso 2
  document.getElementById('btn-toggle-pwd-step2')?.addEventListener('click', () => {
    const inp  = document.getElementById('login-pwd-step2');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    document.getElementById('eye-open-2')?.classList.toggle('hidden', show);
    document.getElementById('eye-closed-2')?.classList.toggle('hidden', !show);
  });
}

/* ── 1. CONSTANTES ─────────────────────────────────────────── */

/* ── Etapas — 3 Fases · 14 Etapas ──────────────────────────── */
const ETAPAS = [
  // ── FASE 1: PROSPECCIÓN (5 etapas) ──────────────────────────
  { id:'prospecto_id',  label:'Prospecto Identificado', emoji:'🔍', fase:'prospeccion',
    color:'#818CF8', bg:'#EEF2FF', tc:'#4338CA',
    gate:'Pain visible, sin contacto aún' },
  { id:'contacto_env',  label:'Contacto Enviado',        emoji:'📩', fase:'prospeccion',
    color:'#6366F1', bg:'#E0E7FF', tc:'#3730A3',
    gate:'Mensaje personalizado <24h de identificar' },
  { id:'conv_activa',   label:'Conversación Activa',     emoji:'💬', fase:'prospeccion',
    color:'#4F46E5', bg:'#E0E7FF', tc:'#3730A3',
    gate:'Prospecto respondió, diálogo abierto' },
  { id:'diag_agendado', label:'Diagnóstico Agendado',    emoji:'📅', fase:'prospeccion',
    color:'#4338CA', bg:'#C7D2FE', tc:'#312E81',
    gate:'Fecha y hora de llamada confirmada' },
  { id:'opor_cal',      label:'Oportunidad Calificada',  emoji:'⭐', fase:'prospeccion',
    color:'#3730A3', bg:'#C7D2FE', tc:'#312E81',
    gate:'MEDDIC ≥4/6 post-llamada' },
  // ── FASE 2: CIERRE (4 etapas) ───────────────────────────────
  { id:'propuesta_env', label:'Propuesta Enviada',       emoji:'📄', fase:'cierre',
    color:'#F59E0B', bg:'#FEF3C7', tc:'#B45309',
    gate:'Propuesta enviada <24h post-llamada' },
  { id:'negociacion',   label:'En Negociación',          emoji:'🤝', fase:'cierre',
    color:'#F97316', bg:'#FFF7ED', tc:'#C2410C',
    gate:'Prospecto respondió, hay diálogo activo' },
  { id:'ganado',        label:'Cerrado Ganado ✅',        emoji:'✅', fase:'cierre',
    color:'#10B981', bg:'#D1FAE5', tc:'#065F46',
    gate:'Anticipo 50% recibido + contrato firmado' },
  { id:'perdido',       label:'Cerrado Perdido ❌',       emoji:'❌', fase:'cierre',
    color:'#EF4444', bg:'#FEE2E2', tc:'#B91C1C',
    gate:'No explícito O 14 días sin respuesta' },
  // ── FASE 3: POST-VENTA (5 etapas) ───────────────────────────
  { id:'onboarding',    label:'Onboarding Activo',       emoji:'🚀', fase:'postventa',
    color:'#0D9488', bg:'#F0FDFB', tc:'#0F766E',
    gate:'Plan de 14 días activado post-entrega' },
  { id:'mantenimiento', label:'Mantenimiento Activo',    emoji:'🔧', fase:'postventa',
    color:'#0F766E', bg:'#CCFBF1', tc:'#134E4A',
    gate:'Contrato R1/R2 activo y pagando' },
  { id:'upsell',        label:'Candidato a Upsell',      emoji:'📈', fase:'postventa',
    color:'#10B981', bg:'#D1FAE5', tc:'#065F46',
    gate:'NPS ≥8 + necesidad adicional identificada' },
  { id:'reactivacion',  label:'En Reactivación',         emoji:'♻️',  fase:'postventa',
    color:'#F59E0B', bg:'#FEF3C7', tc:'#B45309',
    gate:'Cliente inactivo >30 días, recontactado' },
  { id:'referido',      label:'Referido Generado',       emoji:'🌟', fase:'postventa',
    color:'#8B5CF6', bg:'#F5F3FF', tc:'#7C3AED',
    gate:'Cliente refirió a 1+ prospecto verificado' },
];

/* ── Fases ──────────────────────────────────────────────────── */
const FASES = [
  { id:'prospeccion', label:'PROSPECCIÓN', n:1,
    color:'#4338CA', bg:'#EEF2FF', tc:'#312E81',
    desc:'Identificar y calificar al prospecto correcto' },
  { id:'cierre',      label:'CIERRE',      n:2,
    color:'#B45309', bg:'#FEF3C7', tc:'#92400E',
    desc:'Convertir la oportunidad en cliente pagante' },
  { id:'postventa',   label:'POST-VENTA',  n:3,
    color:'#0F766E', bg:'#CCFBF1', tc:'#134E4A',
    desc:'Retención, crecimiento y generación de referidos' },
];

const ACT_ICONS  = { whatsapp:'💬', llamada:'📞', email:'📧', reunion:'🤝', propuesta:'📄', nota:'📝' };
const ACT_LABELS = { whatsapp:'WhatsApp', llamada:'Llamada', email:'Email', reunion:'Reunión', propuesta:'Propuesta', nota:'Nota' };
const ACT_BG     = { whatsapp:'#D1FAE5', llamada:'#EFF6FF', email:'#EEF2FF', reunion:'#F5F3FF', propuesta:'#FEF3C7', nota:'#F8F9FB' };

const STORAGE_KEY = 'node_crm_v2';

const PAGE_META = {
  dashboard:        { title:'Dashboard',              sub:'Resumen de tu pipeline y actividades' },
  pipeline:         { title:'Pipeline',               sub:'Gestiona tus deals en el Kanban' },
  contactos:        { title:'Contactos',              sub:'Tu cartera de prospectos y clientes' },
  actividades:      { title:'Actividades',            sub:'Historial completo de interacciones' },
  configuracion:    { title:'Configuración',          sub:'Ajustes de cuenta y exportación de datos' },
  'prospecto-form': { title:'Formulario de Contacto', sub:'Completa tus datos y nos ponemos en contacto contigo' },
};

/* ── 2. ESTADO ─────────────────────────────────────────────── */

const S = {
  view:          'dashboard',
  contactos:     [],
  deals:         [],
  actividades:   [],
  config:        { empresa:'NODE Soluciones Tecnológicas', usuario:'CEO NODE', whatsapp:'', moneda:'MXN' },
  searchQuery:   '',
  filterFuente:  '',
  filterActTipo: '',
  charts:        {},
  sortables:     [],
};

/* ── 3. PERSISTENCIA ───────────────────────────────────────── */

async function saveState() {
  try {
    if (AUTH.role === 'venta' && AUTH.profileId) {
      await saveVendedorData(AUTH.profileId, {
        contactos:   S.contactos,
        deals:       S.deals,
        actividades: S.actividades,
      });
      const global = await sbGet(STORAGE_KEY) || {};
      await sbSet(STORAGE_KEY, { ...global, config: S.config });
    } else {
      await sbSet(STORAGE_KEY, {
        contactos:   S.contactos,
        deals:       S.deals,
        actividades: S.actividades,
        config:      S.config,
      });
    }
  } catch(e) { console.warn('Storage write error:', e); }
}

async function loadState() {
  try {
    if (AUTH.role === 'venta' && AUTH.profileId) {
      const vd = await getVendedorData(AUTH.profileId);
      S.contactos   = vd.contactos   || [];
      S.deals       = vd.deals       || [];
      S.actividades = vd.actividades || [];
      const global = await sbGet(STORAGE_KEY) || {};
      S.config = Object.assign({}, S.config, global.config || {});
      return true;
    } else {
      const d = await sbGet(STORAGE_KEY);
      if (!d) return false;
      S.contactos   = d.contactos   || [];
      S.deals       = d.deals       || [];
      S.actividades = d.actividades || [];
      S.config      = Object.assign({}, S.config, d.config || {});
      return true;
    }
  } catch(e) { return false; }
}
/* ── 4. DATOS DE MUESTRA ───────────────────────────────────── */

function seedData() {
  const now = Date.now();
  const ago = (days) => now - days * 86_400_000;

  // seedData solo aplica a admin/ventas (datos globales compartidos)
  // Los vendedores individuales arrancan con datos vacíos
  if (AUTH.role === 'venta') return;

  S.contactos = [
    { id:'c1', nombre:'Ana García',        empresa:'Fotografía AG',          whatsapp:'5512345671', email:'ana@fotografiaag.mx',    fuente:'Instagram', monto:8000,  notas:'Fotógrafa de bodas, quiere presencia profesional en web.', creadoEn:ago(15), actualizadoEn:ago(2)  },
    { id:'c2', nombre:'Roberto Hernández', empresa:'Taller Hernández',       whatsapp:'5523456782', email:'roberto@tallerhz.mx',     fuente:'Referido',  monto:5500,  notas:'Taller mecánico, necesita cotizador para sus servicios.',   creadoEn:ago(20), actualizadoEn:ago(5)  },
    { id:'c3', nombre:'Sofía López',       empresa:'Consultoría Fiscal SL',  whatsapp:'5534567893', email:'sofia@cfiscal.mx',         fuente:'LinkedIn',  monto:17200, notas:'Contadora independiente, clientes piden CFDI 4.0.',        creadoEn:ago(10), actualizadoEn:ago(1)  },
    { id:'c4', nombre:'Carlos Martínez',   empresa:'Pastelería Martínez',    whatsapp:'5545678904', email:'carlos@pasteleriam.mx',    fuente:'Facebook',  monto:4500,  notas:'Vende artesanalmente por Instagram y pedidos por WA.',      creadoEn:ago(8),  actualizadoEn:ago(3)  },
    { id:'c5', nombre:'Diana Ruiz',        empresa:'DR Diseño Gráfico',      whatsapp:'5556789015', email:'diana@drdisenio.mx',       fuente:'Instagram', monto:12500, notas:'Diseñadora freelance, cotiza todo por WhatsApp.',           creadoEn:ago(30), actualizadoEn:ago(7)  },
    { id:'c6', nombre:'Pedro Sánchez',     empresa:'Estudio Pilates PS',     whatsapp:'5567890126', email:'pedro@estudiops.mx',       fuente:'LinkedIn',  monto:6500,  notas:'Instructor, emite facturas RESICO de forma manual.',        creadoEn:ago(40), actualizadoEn:ago(0)  },
    { id:'c7', nombre:'Marina Torres',     empresa:'Clínica Dental Torres',  whatsapp:'5578901237', email:'marina@clinicatorres.mx',  fuente:'Google',    monto:8000,  notas:'Odontóloga, pacientes corporativos exigen factura.',         creadoEn:ago(25), actualizadoEn:ago(10) },
    { id:'c8', nombre:'Luis Vega',         empresa:'Vega Construcción',      whatsapp:'5589012348', email:'luis@vegaconstruccion.mx', fuente:'Referido',  monto:8500,  notas:'Constructor, cotizaciones en PDF manual sin proceso.',       creadoEn:ago(12), actualizadoEn:ago(4)  },
  ];

  // deals con vendedorId asignado (distribuido entre vendedores de ejemplo)
  S.deals = [
    { id:'d1',  titulo:'Landing Page Pro',         contactoId:'c1', valor:8000,  etapa:'propuesta_env', fechaLimite:'2026-06-20', proximaAccion:'Enviar contrato firmado',         notas:'',                               vendedorId:'vendedor1', creadoEn:ago(14), actualizadoEn:ago(2)  },
    { id:'d2',  titulo:'Cotizador Digital Pro',    contactoId:'c2', valor:5500,  etapa:'diag_agendado', fechaLimite:'2026-06-10', proximaAccion:'Demo miércoles 10am',              notas:'',                               vendedorId:'vendedor1', creadoEn:ago(18), actualizadoEn:ago(5)  },
    { id:'d3',  titulo:'Bundle Vende Más (B2)',    contactoId:'c3', valor:17200, etapa:'negociacion',   fechaLimite:'2026-06-08', proximaAccion:'Revisar términos de pago',         notas:'Quiere pago en 2 parcialidades.', vendedorId:'vendedor2', creadoEn:ago(9),  actualizadoEn:ago(1)  },
    { id:'d4',  titulo:'Landing Page Básica',      contactoId:'c4', valor:4500,  etapa:'prospecto_id',  fechaLimite:'2026-07-01', proximaAccion:'Enviar mensaje personalizado',     notas:'',                               vendedorId:'vendedor2', creadoEn:ago(7),  actualizadoEn:ago(3)  },
    { id:'d5',  titulo:'NODE CRM P6',              contactoId:'c5', valor:12500, etapa:'contacto_env',  fechaLimite:'2026-06-25', proximaAccion:'Agendar diagnóstico',              notas:'',                               vendedorId:'vendedor3', creadoEn:ago(28), actualizadoEn:ago(6)  },
    { id:'d6',  titulo:'Facturador CFDI Básico',   contactoId:'c6', valor:6500,  etapa:'onboarding',    fechaLimite:'2026-05-30', proximaAccion:'D+3: ofrecer mantenimiento R1',    notas:'Anticipo 50% recibido.',         vendedorId:'vendedor3', creadoEn:ago(38), actualizadoEn:ago(2)  },
    { id:'d7',  titulo:'Landing Page Pro',         contactoId:'c7', valor:8000,  etapa:'perdido',       fechaLimite:'2026-05-15', proximaAccion:'—',                               notas:'Eligió agencia local más barata.', vendedorId:'vendedor1', creadoEn:ago(23), actualizadoEn:ago(10) },
    { id:'d8',  titulo:'Bundle STARTER (B1)',      contactoId:'c8', valor:8500,  etapa:'propuesta_env', fechaLimite:'2026-06-18', proximaAccion:'Follow-up mañana temprano',        notas:'',                               vendedorId:'vendedor2', creadoEn:ago(11), actualizadoEn:ago(4)  },
    { id:'d9',  titulo:'Cotizador + Landing Pro',  contactoId:'c1', valor:14000, etapa:'conv_activa',   fechaLimite:'2026-07-10', proximaAccion:'Agendar diagnóstico esta semana',  notas:'Segunda oportunidad con Ana.',   vendedorId:'vendedor1', creadoEn:ago(3),  actualizadoEn:ago(1)  },
    { id:'d10', titulo:'Mantenimiento Anual',      contactoId:'c6', valor:14400, etapa:'mantenimiento', fechaLimite:'2027-05-30', proximaAccion:'Renovar en 30 días',               notas:'R2 activo desde junio.',         vendedorId:'vendedor3', creadoEn:ago(35), actualizadoEn:ago(0)  },
    { id:'d11', titulo:'Bundle PRO Upsell',        contactoId:'c3', valor:14500, etapa:'upsell',        fechaLimite:'2026-07-15', proximaAccion:'Proponer bundle PRO en llamada',   notas:'NPS 9. Lista para crecer.',      vendedorId:'vendedor2', creadoEn:ago(5),  actualizadoEn:ago(0)  },
    { id:'d12', titulo:'Opor. Calificada — POS',   contactoId:'c2', valor:9500,  etapa:'opor_cal',      fechaLimite:'2026-06-30', proximaAccion:'Enviar propuesta P7 + POS',        notas:'MEDDIC 5/6.',                    vendedorId:'vendedor3', creadoEn:ago(4),  actualizadoEn:ago(1)  },
  ];
S.deals.forEach(d => {
  if (['ganado', 'onboarding'].includes(d.etapa) && !d.onboardingStartedAt) {
    d.onboardingStartedAt = d.actualizadoEn || d.creadoEn;
  }
});
saveState();
  S.actividades = [
    { id:'a1',  tipo:'whatsapp',  contactoId:'c3', descripcion:'Revisó la propuesta B2. Pide pago en 2 parcialidades, avaluamos acepta.',   creadoEn:ago(1)  },
    { id:'a2',  tipo:'llamada',   contactoId:'c2', descripcion:'Confirmó demo del cotizador para el miércoles 10am. Muy entusiasmado.',      creadoEn:ago(2)  },
    { id:'a3',  tipo:'email',     contactoId:'c3', descripcion:'Envié contrato preliminar para revisión. Pendiente firma del cliente.',      creadoEn:ago(3)  },
    { id:'a4',  tipo:'reunion',   contactoId:'c4', descripcion:'Visita a su local. Le gustó la propuesta de landing básica.',                creadoEn:ago(4)  },
    { id:'a5',  tipo:'whatsapp',  contactoId:'c1', descripcion:'Ana aprobó el diseño. Solicita ajuste en el texto del hero section.',        creadoEn:ago(5)  },
    { id:'a6',  tipo:'nota',      contactoId:'c8', descripcion:'Luis llegó por referencia de Pedro. Excelente prospecto para Bundle B1.',    creadoEn:ago(6)  },
    { id:'a7',  tipo:'propuesta', contactoId:'c8', descripcion:'Envié propuesta formal del Bundle STARTER (P1+P3) por $8,500 MXN.',          creadoEn:ago(7)  },
    { id:'a8',  tipo:'email',     contactoId:'c6', descripcion:'Pedro realizó pago del 50% anticipo — $3,250 MXN. Iniciamos esta semana.',   creadoEn:ago(0)  },
    { id:'a9',  tipo:'whatsapp',  contactoId:'c5', descripcion:'Diana preguntó funciones del CRM. Le expliqué pipeline y cotizador.',        creadoEn:ago(8)  },
    { id:'a10', tipo:'llamada',   contactoId:'c7', descripcion:'Marina confirmó que no continúa. Eligió agencia local. Post-mortem hecho.',  creadoEn:ago(10) },
  ];
}

/* ── 5. HELPERS ────────────────────────────────────────────── */

const uid = () => '_' + Math.random().toString(36).slice(2, 10);

function initials(name = '') {
  return name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
}

function fmtMXN(n) {
  return new Intl.NumberFormat('es-MX', { style:'currency', currency:'MXN', maximumFractionDigits:0 }).format(n || 0);
}

function fmtDate(val) {
  if (!val) return '—';
  const d = val instanceof Date ? val : new Date(typeof val === 'number' ? val : val + 'T00:00:00');
  return d.toLocaleDateString('es-MX', { day:'2-digit', month:'short', year:'numeric' });
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 2)  return 'Justo ahora';
  if (m < 60) return `Hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Hace ${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7)  return `Hace ${d}d`;
  return fmtDate(ts);
}

function isOverdue(dateStr) {
  if (!dateStr) return false;
  return new Date(dateStr + 'T00:00:00') < new Date();
}

function escapeHTML(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

const getEtapa      = (id) => ETAPAS.find(e => e.id === id) || ETAPAS[0];
const getContacto   = (id) => S.contactos.find(c => c.id === id);
const dealsByEtapa  = (id) => S.deals.filter(d => d.etapa === id);
const actsByContact = (id) => S.actividades.filter(a => a.contactoId === id).sort((a,b) => b.creadoEn - a.creadoEn);
const dealsByContact= (id) => S.deals.filter(d => d.contactoId === id);

/* ── 6. ROUTER ─────────────────────────────────────────────── */

function navigate(view) {
  // Clean up previous charts & sortables
  Object.values(S.charts).forEach(c => c?.destroy?.());
  S.charts = {};
  S.sortables.forEach(s => s?.destroy?.());
  S.sortables = [];
  // Reset drill-down al salir del dashboard
  if (view !== 'dashboard') CHART_STATE.expandedFase = null;
  S.view = view;

  // Nav highlight
  document.querySelectorAll('.nav-item[data-view]').forEach(b => {
    b.classList.toggle('active', b.dataset.view === view);
  });

  // Page heading
  const meta = PAGE_META[view] || {};
  document.getElementById('page-title').textContent = meta.title || view;
  document.getElementById('page-sub').textContent   = meta.sub   || '';

  // Render with animation
  const content = document.getElementById('content');
  content.innerHTML = '';
  content.classList.remove('view-enter');
  void content.offsetWidth;
  content.classList.add('view-enter');

  // Enrutar según rol: admin y ventas usan vistas consolidadas
  const isAdmin = AUTH.role === 'admin' || AUTH.role === 'ventas';

  const views = {
    dashboard:        isAdmin ? dashboardAdmin   : dashboard,
    pipeline:         isAdmin ? pipelineAdmin    : pipeline,
    contactos:        isAdmin ? contactosAdmin   : contactos,
    actividades:      isAdmin ? actividadesAdmin : actividades,
    configuracion,
    'prospecto-form': prospectoForm,
  };
  views[view]?.();
}

/* ── 7. DASHBOARD ──────────────────────────────────────────── */

function dashboard() {
  const active      = S.deals.filter(d => d.etapa !== 'ganado' && d.etapa !== 'perdido');
  const pipeValue   = active.reduce((s, d) => s + (d.valor || 0), 0);
  const thisMonth   = new Date().getMonth();
  const wonMonth    = S.deals.filter(d => d.etapa === 'ganado' && new Date(d.actualizadoEn).getMonth() === thisMonth).length;  const weekAgo     = Date.now() - 7 * 86_400_000;
  const actsWeek    = S.actividades.filter(a => a.creadoEn >= weekAgo).length;

  const recentActs  = [...S.actividades].sort((a,b) => b.creadoEn - a.creadoEn).slice(0, 5);
  const topDeals    = [...active].sort((a,b) => b.valor - a.valor).slice(0, 5);

  document.getElementById('content').innerHTML = `
  <div class="stats-grid">
    ${mkStatCard('🎯','Leads activos',       active.length,     '#EEF2FF','#4338CA')}
    ${mkStatCard('💰','Valor del pipeline',  fmtMXN(pipeValue), '#F0FDFB','#0D9488')}
    ${mkStatCard('✅','Ganados este mes',     wonMonth,          '#D1FAE5','#10B981')}
    ${mkStatCard('📋','Actividades / semana',actsWeek,          '#FEF3C7','#F59E0B')}
  </div>

  <div class="dashboard-cols">
    <div class="chart-card">
      <div class="chart-title">Pipeline por etapa</div>
      <div class="chart-sub">Valor de deals activos por etapa (MXN)</div>
      <div class="chart-canvas"><canvas id="chart-bar"></canvas></div>
    </div>
    <div class="chart-card">
      <div class="chart-title">Distribución de deals</div>
      <div class="chart-sub">Cantidad de deals por estado actual</div>
      <div class="chart-canvas"><canvas id="chart-donut"></canvas></div>
    </div>
  </div>

  <div class="dashboard-bottom">
    <div class="chart-card">
      <div class="panel-title">Actividades recientes</div>
      ${recentActs.length
        ? recentActs.map(a => miniActHTML(a)).join('')
        : emptyState('📋','Sin actividades','Registra tu primera interacción.')}
    </div>
    <div class="chart-card">
      <div class="panel-title">Top deals en pipeline</div>
      ${topDeals.length
        ? topDeals.map(d => miniDealHTML(d)).join('')
        : emptyState('⭐','Sin deals activos','Agrega deals al pipeline.')}
    </div>
  </div>`;

  requestAnimationFrame(buildCharts);
}

function mkStatCard(icon, label, value, bg, iconColor) {
  return `<div class="stat-card">
    <div class="stat-icon" style="background:${bg}"><span style="font-size:20px">${icon}</span></div>
    <div class="stat-label">${label}</div>
    <div class="stat-value" style="color:${iconColor}">${value}</div>
  </div>`;
}

function emptyState(icon, title, desc) {
  return `<div class="empty" style="padding:24px 16px">
    <div class="empty-icon">${icon}</div>
    <p class="empty-title">${title}</p>
    <p class="empty-desc" style="margin-bottom:0">${desc}</p>
  </div>`;
}

function miniActHTML(a) {
  const c = getContacto(a.contactoId);
  return `<div class="act-mini">
    <div class="act-icon" style="background:${ACT_BG[a.tipo]||'#f8f9fb'}">${ACT_ICONS[a.tipo]||'📌'}</div>
    <div style="flex:1;min-width:0">
      <div style="font-size:12px;font-weight:600;color:var(--ink)">${escapeHTML(c?.nombre||'—')}
        <span style="font-size:11px;font-weight:400;color:var(--n-500)"> · ${ACT_LABELS[a.tipo]||a.tipo}</span>
      </div>
      <div class="act-desc">${escapeHTML(a.descripcion)}</div>
    </div>
    <div class="act-time">${timeAgo(a.creadoEn)}</div>
  </div>`;
}

function miniDealHTML(d) {
  const c = getContacto(d.contactoId);
  const e = getEtapa(d.etapa);
  return `<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--n-100)">
    <div style="flex:1;min-width:0">
      <div style="font-size:13px;font-weight:600;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHTML(d.titulo)}</div>
      <div style="font-size:11px;color:var(--n-500)">${escapeHTML(c?.nombre||'—')}</div>
    </div>
    <div style="text-align:right;flex-shrink:0">
      <div class="money" style="font-size:14px;font-weight:700;color:var(--indigo)">${fmtMXN(d.valor)}</div>
      <span class="badge" style="background:${e.bg};color:${e.tc};font-size:10px;padding:1px 7px">${e.label}</span>
    </div>
  </div>`;
}

/* ── Estado del drill-down de gráficas ── */
const CHART_STATE = { expandedFase: null }; // null = vista de 3 fases agrupadas

function buildCharts() {
  buildBarChart();
  buildDonutChart();
}

/* ── BAR CHART: vista agrupada por fase o desglosada por etapa ── */
function buildBarChart() {
  const barEl = document.getElementById('chart-bar');
  if (!barEl) return;

  // Destruir instancia previa
  if (S.charts.bar) { S.charts.bar.destroy(); S.charts.bar = null; }

  const expanded = CHART_STATE.expandedFase;

  // ── Vista agrupada: 3 fases ───────────────────────────────────
  if (!expanded) {
    const faseData = FASES.map(f => {
      const etapasIds = ETAPAS.filter(e => e.fase === f.id).map(e => e.id);
      const valor     = S.deals.filter(d => etapasIds.includes(d.etapa)).reduce((s,d) => s+(d.valor||0), 0);
      return { label: f.label, valor, color: f.color, bg: f.bg, tc: f.tc, id: f.id };
    });

    // Inyectar hint de click
    const wrap = barEl.closest('.chart-card');
    let hint = wrap.querySelector('.chart-hint');
    if (!hint) {
      hint = document.createElement('div');
      hint.className = 'chart-hint';
      hint.textContent = '👆 Haz clic en una barra para desglosar sus etapas';
      wrap.querySelector('.chart-sub').after(hint);
    }

    S.charts.bar = new Chart(barEl, {
      type: 'bar',
      data: {
        labels: faseData.map(f => f.label),
        datasets: [{
          data:            faseData.map(f => f.valor),
          backgroundColor: faseData.map(f => f.bg),
          borderColor:     faseData.map(f => f.color),
          borderWidth: 2,
          borderRadius: 8,
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        onClick: (_evt, elements) => {
          if (!elements.length) return;
          const idx = elements[0].index;
          CHART_STATE.expandedFase = faseData[idx].id;
          // Redibujar ambas gráficas en modo desglose
          if (S.charts.bar)   { S.charts.bar.destroy();   S.charts.bar   = null; }
          if (S.charts.donut) { S.charts.donut.destroy();  S.charts.donut = null; }
          buildBarChart();
          buildDonutChart();
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => ' ' + fmtMXN(ctx.raw) } }
        },
        scales: {
          x: { grid: { color: '#E4E8F0' }, ticks: { callback: v => fmtMXN(v), font: { family: 'Space Grotesk, system-ui', size: 10 } } },
          y: { grid: { display: false },   ticks: { font: { family: 'Space Grotesk, system-ui', size: 12, weight: '600' } } }
        }
      }
    });
    return;
  }

  // ── Vista desglosada: etapas de la fase seleccionada ─────────
  const fase     = FASES.find(f => f.id === expanded);
  const etapas   = ETAPAS.filter(e => e.fase === expanded);
  const vals     = etapas.map(e => S.deals.filter(d => d.etapa === e.id).reduce((s,d) => s+(d.valor||0), 0));

  // Botón "volver"
  const wrap = barEl.closest('.chart-card');
  let backBtn = wrap.querySelector('.chart-back-btn');
  if (!backBtn) {
    backBtn = document.createElement('button');
    backBtn.className = 'chart-back-btn';
    backBtn.innerHTML = '← Volver a fases';
    backBtn.onclick = () => {
      CHART_STATE.expandedFase = null;
      if (S.charts.bar)   { S.charts.bar.destroy();   S.charts.bar   = null; }
      if (S.charts.donut) { S.charts.donut.destroy();  S.charts.donut = null; }
      // Limpiar UI dinámica
      wrap.querySelector('.chart-back-btn')?.remove();
      wrap.querySelector('.chart-hint')?.remove();
      wrap.querySelector('.chart-fase-label')?.remove();
      const wrap2 = document.querySelector('#chart-donut')?.closest('.chart-card');
      wrap2?.querySelector('.chart-back-btn')?.remove();
      wrap2?.querySelector('.chart-fase-label')?.remove();
      buildBarChart();
      buildDonutChart();
    };
    wrap.querySelector('.chart-sub').after(backBtn);
  }

  // Label de fase activa
  let faseLabel = wrap.querySelector('.chart-fase-label');
  if (!faseLabel) {
    faseLabel = document.createElement('div');
    faseLabel.className = 'chart-fase-label';
    backBtn.after(faseLabel);
  }
  faseLabel.innerHTML = `<span style="background:${fase.bg};color:${fase.tc};border:1px solid ${fase.color}33" class="fase-pill">F${fase.n} ${fase.label}</span> — etapas`;

  // Quitar hint si quedó
  wrap.querySelector('.chart-hint')?.remove();

  S.charts.bar = new Chart(barEl, {
    type: 'bar',
    data: {
      labels: etapas.map(e => `${e.emoji} ${e.label}`),
      datasets: [{
        data:            vals,
        backgroundColor: etapas.map(e => e.bg),
        borderColor:     etapas.map(e => e.color),
        borderWidth: 2,
        borderRadius: 6,
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ' ' + fmtMXN(ctx.raw) } }
      },
      scales: {
        x: { grid: { color: '#E4E8F0' }, ticks: { callback: v => fmtMXN(v), font: { family: 'Space Grotesk, system-ui', size: 10 } } },
        y: { grid: { display: false },   ticks: { font: { family: 'Space Grotesk, system-ui', size: 10 } } }
      }
    }
  });
}

/* ── DONUT CHART: por fase o por etapas de la fase seleccionada ── */
function buildDonutChart() {
  const donutEl = document.getElementById('chart-donut');
  if (!donutEl) return;
  if (S.charts.donut) { S.charts.donut.destroy(); S.charts.donut = null; }

  const expanded = CHART_STATE.expandedFase;
  const wrap     = donutEl.closest('.chart-card');

  // ── Vista agrupada: 3 fases ───────────────────────────────────
  if (!expanded) {
    // Limpiar elementos de desglose
    wrap.querySelector('.chart-back-btn')?.remove();
    wrap.querySelector('.chart-fase-label')?.remove();

    const faseData = FASES.map(f => {
      const etapasIds = ETAPAS.filter(e => e.fase === f.id).map(e => e.id);
      const count     = S.deals.filter(d => etapasIds.includes(d.etapa)).length;
      return { label: f.label, count, color: f.color, bg: f.bg };
    });

    if (faseData.every(f => f.count === 0)) {
      donutEl.closest('.chart-canvas').innerHTML = emptyState('📊','Sin datos','Agrega deals para ver la distribución.');
      return;
    }

    S.charts.donut = new Chart(donutEl, {
      type: 'doughnut',
      data: {
        labels:   faseData.map(f => f.label),
        datasets: [{ data: faseData.map(f => f.count), backgroundColor: faseData.map(f => f.bg), borderColor: faseData.map(f => f.color), borderWidth: 2 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '68%',
        plugins: {
          legend: { position: 'right', labels: { font: { family: 'Space Grotesk, system-ui', size: 12, weight: '600' }, boxWidth: 14, padding: 12 } },
          tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${ctx.raw} deal${ctx.raw !== 1 ? 's' : ''}` } }
        }
      }
    });
    return;
  }

  // ── Vista desglosada: etapas de la fase ──────────────────────
  const fase   = FASES.find(f => f.id === expanded);
  const etapas = ETAPAS.filter(e => e.fase === expanded);
  const counts = etapas.map(e => S.deals.filter(d => d.etapa === e.id).length);

  // Label de fase activa en el donut
  let faseLabel = wrap.querySelector('.chart-fase-label');
  if (!faseLabel) {
    faseLabel = document.createElement('div');
    faseLabel.className = 'chart-fase-label';
    wrap.querySelector('.chart-sub').after(faseLabel);
  }
  faseLabel.innerHTML = `<span style="background:${fase.bg};color:${fase.tc};border:1px solid ${fase.color}33" class="fase-pill">F${fase.n} ${fase.label}</span>`;

  if (counts.every(v => v === 0)) {
    donutEl.closest('.chart-canvas').innerHTML = emptyState('📊','Sin deals','Esta fase no tiene deals aún.');
    return;
  }

  S.charts.donut = new Chart(donutEl, {
    type: 'doughnut',
    data: {
      labels:   etapas.map(e => `${e.emoji} ${e.label}`),
      datasets: [{ data: counts, backgroundColor: etapas.map(e => e.bg), borderColor: etapas.map(e => e.color), borderWidth: 2 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '68%',
      plugins: {
        legend: { position: 'right', labels: { font: { family: 'Space Grotesk, system-ui', size: 11 }, boxWidth: 12, padding: 8 } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${ctx.raw} deal${ctx.raw !== 1 ? 's' : ''}` } }
      }
    }
  });
}

/* ── 8. PIPELINE KANBAN ─────────────────────────────────────── */

function pipeline() {
  const nonClosedIds  = ['ganado','perdido'];
  const totalActive   = S.deals.filter(d => !nonClosedIds.includes(d.etapa)).reduce((s,d) => s+(d.valor||0), 0);
  const totalGanado   = S.deals.filter(d => d.etapa === 'ganado').reduce((s,d) => s+(d.valor||0), 0);
  const totalDeals    = S.deals.filter(d => !nonClosedIds.includes(d.etapa)).length;

  let html = `
  <div class="pipeline-header">
    <div class="pipeline-stats">
      <span class="pipe-stat">
        <span class="pipe-stat-label">Pipeline activo</span>
        <strong class="pipe-stat-val indigo">${fmtMXN(totalActive)}</strong>
      </span>
      <span class="pipe-stat-sep"></span>
      <span class="pipe-stat">
        <span class="pipe-stat-label">Deals activos</span>
        <strong class="pipe-stat-val teal">${totalDeals}</strong>
      </span>
      <span class="pipe-stat-sep"></span>
      <span class="pipe-stat">
        <span class="pipe-stat-label">Ganado total</span>
        <strong class="pipe-stat-val green">${fmtMXN(totalGanado)}</strong>
      </span>
    </div>
    <button class="btn btn-primary" onclick="openDealModal()">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      Nuevo deal
    </button>
  </div>

  <div class="pipeline-phases-container">`;

  FASES.forEach(fase => {
    const faseEtapas = ETAPAS.filter(e => e.fase === fase.id);
    const faseDeals  = S.deals.filter(d => faseEtapas.some(e => e.id === d.etapa));
    const faseValue  = faseDeals.reduce((s,d) => s+(d.valor||0), 0);

    html += `
    <div class="fase-group">
      <div class="fase-header" style="background:${fase.bg}">
        <div class="fase-header-left">
          <span class="fase-num" style="background:${fase.color}">F${fase.n}</span>
          <div>
            <div class="fase-title" style="color:${fase.tc}">${fase.label}</div>
            <div class="fase-desc" style="color:${fase.tc}aa">${fase.desc}</div>
          </div>
        </div>
        <div class="fase-header-right">
          <span class="fase-badge" style="background:${fase.color}1a;color:${fase.tc}">${faseDeals.length} deal${faseDeals.length !== 1 ? 's' : ''}</span>
          ${faseValue > 0 ? `<span class="fase-badge" style="background:${fase.color}1a;color:${fase.tc}">${fmtMXN(faseValue)}</span>` : ''}
        </div>
      </div>
      <div class="fase-cols">`;

    faseEtapas.forEach(e => {
      const deals    = dealsByEtapa(e.id);
      const colValue = deals.reduce((s,d) => s+(d.valor||0), 0);
      html += `
        <div class="kanban-col">
          <div class="kanban-head" style="background:${e.bg};color:${e.tc}">
            <span>${e.emoji} ${e.label}</span>
            <span class="col-count">${deals.length}</span>
          </div>
          <div class="kanban-gate-chip" title="Gate de entrada: ${e.gate}">
            <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
            ${e.gate}
          </div>
          ${colValue > 0 ? `<div class="col-value-row" style="color:${e.tc}">${fmtMXN(colValue)}</div>` : ''}
          <div class="kanban-cards" data-etapa="${e.id}">
            ${deals.map(d => dealCardHTML(d)).join('')}
          </div>
          <button class="kanban-add" onclick="openDealModal(null,'${e.id}')">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Añadir deal
          </button>
        </div>`;
    });

    html += `
      </div>
    </div>`;
  });

  html += `</div>`;
  document.getElementById('content').innerHTML = html;
  initKanbanSortable();
}

function dealCardHTML(d) {
  const c    = getContacto(d.contactoId);
  const over = isOverdue(d.fechaLimite) && d.etapa !== 'ganado' && d.etapa !== 'perdido';

  // Tracker aparece en onboarding Y en ganado
  const ETAPAS_CON_TRACKER = ['onboarding', 'ganado'];
  const tieneTracker = ETAPAS_CON_TRACKER.includes(d.etapa);

  let trackerHTML = '';
  if (tieneTracker) {
    const MS_DAY = 86_400_000;

    // Usar onboardingStartedAt si existe, si no actualizadoEn, si no creadoEn
    const inicio = d.onboardingStartedAt ?? d.creadoEn;
    const daysSince = Math.floor((Date.now() - inicio) / MS_DAY);
    const progress  = Math.min(daysSince, 14);
    const pct       = Math.round((progress / 14) * 100);

    const milestones = [
      { d:0,  l:'D0',   desc:'Videollamada 45 min · entrega en vivo' },
      { d:1,  l:'D+1',  desc:'WhatsApp: ¿cómo le fue con su primer cliente?' },
      { d:3,  l:'D+3',  desc:'Ofrecer plan R1 o R2 con contexto del producto' },
      { d:7,  l:'D+7',  desc:'NPS 1-10 · si ≥8 pedir testimonio + referido' },
      { d:14, l:'D+14', desc:'Revisión 30 min · ¿qué resultado has visto?' },
    ];

    // Color según etapa
    const trackerColor = d.etapa === 'ganado' ? '#10B981' : '#0D9488';

    trackerHTML = `
    <div class="onboarding-tracker">
      <div class="ob-top">
        <span class="ob-label">Plan 14 días</span>
        <span class="ob-day" style="color:${trackerColor}">D+${progress}</span>
      </div>
      <div class="ob-bar-wrap">
        <div class="ob-bar" style="width:${pct}%;background:linear-gradient(90deg,${trackerColor},#06EDD8)"></div>
      </div>
      <div class="ob-milestones">
        ${milestones.map(m =>
          `<span class="ob-dot${progress >= m.d ? ' done' : ''}"
            style="${progress >= m.d ? `background:${trackerColor};color:#fff` : ''}"
            title="${m.desc}">${m.l}</span>`
        ).join('')}
      </div>
    </div>`;
  }

  // Chip de actividades para dar contexto visual
  const actCount = d.contactoId ? actsByContact(d.contactoId).length : 0;

  return `<div class="deal-card${tieneTracker ? ' deal-onboarding' : ''}"
    data-id="${d.id}"
    onclick="openDealDrawer('${d.id}')"
    ondblclick="event.stopPropagation();openDealModal('${d.id}')"
    title="Clic: ver actividades  ·  Doble clic: editar deal">
    <div class="deal-title">${escapeHTML(d.titulo)}</div>
    ${c ? `<div class="deal-contact-chip">
      <div class="mini-avatar">${initials(c.nombre)}</div>${escapeHTML(c.nombre)}
    </div>` : ''}
    <div class="deal-value">${fmtMXN(d.valor)}</div>
    ${actCount > 0 ? `<div class="deal-act-count">📋 <span>${actCount}</span> actividad${actCount !== 1 ? 'es' : ''}</div>` : ''}
    ${trackerHTML}
    <div class="deal-footer">
      <div class="deal-next">${d.proximaAccion ? '→ '+escapeHTML(d.proximaAccion) : ''}</div>
      ${d.fechaLimite ? `<div class="deal-date${over?' overdue':''}">${over?'⚠️ ':''}${fmtDate(d.fechaLimite)}</div>` : ''}
    </div>
  </div>`;
}

function initKanbanSortable() {
  if (typeof Sortable === 'undefined') return;
  document.querySelectorAll('.kanban-cards').forEach(el => {
    const inst = new Sortable(el, {
      group:       'kanban',
      animation:   200,
      ghostClass:  'sortable-ghost',
      chosenClass: 'sortable-chosen',
      onEnd(evt) {
        const dealId   = evt.item.dataset.id;
        const newEtapa = evt.to.dataset.etapa;
        if (!dealId || !newEtapa) return;
        const deal = S.deals.find(d => d.id === dealId);
        if (deal && deal.etapa !== newEtapa) {
          deal.etapa = newEtapa;
          deal.actualizadoEn = Date.now();
        
         // ← AGREGAR: registrar cuándo inició el onboarding
        if (['ganado','onboarding'].includes(newEtapa) && !deal.onboardingStartedAt) {
         deal.onboardingStartedAt = Date.now();
         }
          saveState();
          // Refresh counts
          document.querySelectorAll('.kanban-col').forEach(col => {
            const etapa = col.querySelector('.kanban-cards')?.dataset?.etapa;
            const count = col.querySelectorAll('.deal-card').length;
            const badge = col.querySelector('.col-count');
            if (badge) badge.textContent = count;
          });
          toast('Deal movido', `→ ${getEtapa(newEtapa).label}`, 'success');
        }
      }
    });
    S.sortables.push(inst);
  });
}

/* ── 9. CONTACTOS ──────────────────────────────────────────── */

function contactos() {
  const q     = S.searchQuery.toLowerCase();
  const filt  = S.filterFuente;
  let list    = [...S.contactos];
  if (q)    list = list.filter(c => `${c.nombre} ${c.empresa} ${c.whatsapp}`.toLowerCase().includes(q));
  if (filt) list = list.filter(c => c.fuente === filt);
  list.sort((a,b) => b.actualizadoEn - a.actualizadoEn);

  const pendientes = list.filter(c => !c.realizado);
  const realizados = list.filter(c =>  c.realizado);

  const fuentes = [...new Set(S.contactos.map(c => c.fuente))];

  let realizadosHTML = '';
  if (realizados.length > 0) {
    realizadosHTML = `
    <div id="section-contactos-realizados" class="realizados-section" style="margin-top:24px">
      <div class="realizados-header">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        Realizados
        <span class="badge badge-neutral" style="font-size:10px">${realizados.length}</span>
      </div>
      <div class="contacts-table-wrap">
        <table class="contacts-table">
          <thead><tr>
            <th>Contacto</th><th>Empresa</th><th>Fuente</th>
            <th>Monto est.</th><th>Actualización</th><th>Acciones</th>
          </tr></thead>
          <tbody>${realizados.map(c => contactRowHTML(c, true)).join('')}</tbody>
        </table>
      </div>
    </div>`;
  }

  document.getElementById('content').innerHTML = `
  <div class="view-header">
    <span class="badge badge-neutral">${S.contactos.length} contactos</span>
    <div class="view-filters">
      <input type="search" class="filter-input" placeholder="🔍 Buscar..." value="${escapeHTML(q)}" oninput="filterContacts(this.value)">
      <select class="filter-input" onchange="filterFuente(this.value)">
        <option value="">Todas las fuentes</option>
        ${fuentes.map(f => `<option value="${f}"${filt===f?' selected':''}>${escapeHTML(f)}</option>`).join('')}
      </select>
      <button class="btn btn-ghost btn-sm" onclick="exportCSV('contactos')" title="Exportar CSV">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        CSV
      </button>
      <button class="btn btn-primary" onclick="openContactoModal()">+ Contacto</button>
    </div>
  </div>
  ${pendientes.length === 0 && realizados.length === 0
    ? `<div class="empty"><div class="empty-icon">👥</div><p class="empty-title">Sin contactos</p><p class="empty-desc">Agrega tu primer prospecto para empezar.</p><button class="btn btn-primary" onclick="openContactoModal()">+ Nuevo contacto</button></div>`
    : `${pendientes.length > 0
        ? `<div class="contacts-table-wrap">
            <table class="contacts-table">
              <thead><tr>
                <th>Contacto</th><th>Empresa</th><th>Fuente</th>
                <th>Monto est.</th><th>Actualización</th><th>Acciones</th>
              </tr></thead>
              <tbody>${pendientes.map(c => contactRowHTML(c, false)).join('')}</tbody>
            </table>
          </div>`
        : ''}
       ${realizadosHTML}`
  }`;
}

function contactRowHTML(c, isRealizado = false) {
  // Etapa del deal más reciente del contacto
  const deals = dealsByContact(c.id)
    .sort((x, y) => y.actualizadoEn - x.actualizadoEn);

  const dealActivo = deals.find(d => d.etapa !== 'perdido') || deals[0];
  const etapa  = dealActivo ? getEtapa(dealActivo.etapa) : null;
  const rowBg  = isRealizado ? 'var(--teal-25, #f0fdfb)' : (etapa ? etapa.bg : 'transparent');

  // Badge de etapa para la columna Fuente
  const etapaBadge = etapa
    ? `<span class="badge"
         style="background:${etapa.bg};color:${etapa.tc};
                border:1px solid ${etapa.color}33;margin-left:6px">
         ${etapa.emoji} ${etapa.label}
       </span>`
    : '';

  return `<tr onclick="openDetalleModal('${c.id}')"
    title="Ver detalle de ${escapeHTML(c.nombre)}"
    style="background:${rowBg}${isRealizado ? ';opacity:.8' : ''}">
    <td><div class="contact-row-name">
      <div class="contact-avatar"
        style="background:${isRealizado ? '#0D9488' : (etapa?.color||'var(--indigo)')}">
        ${isRealizado ? '✅' : initials(c.nombre)}
      </div>
      <div>
        <div class="contact-name">${escapeHTML(c.nombre)}</div>
        <div class="contact-email">${escapeHTML(c.email||'—')}</div>
      </div>
    </div></td>
    <td style="font-size:13px;color:var(--n-600)">${escapeHTML(c.empresa||'—')}</td>
    <td><span class="badge badge-indigo">${escapeHTML(c.fuente)}</span>${etapaBadge}</td>
    <td class="money" style="font-size:13px">${fmtMXN(c.monto)}</td>
    <td style="font-size:12px;color:var(--n-500)">${timeAgo(c.actualizadoEn)}</td>
    <td onclick="event.stopPropagation()"><div class="table-actions">
      <a href="https://wa.me/52${c.whatsapp}?text=Hola%20${encodeURIComponent(c.nombre)}%2C%20te%20contacto%20de%20NODE."
        target="_blank" rel="noopener noreferrer"
        class="contact-wa-btn" title="Abrir WhatsApp">💬</a>
      <button class="icon-btn" onclick="openContactoModal('${c.id}')" title="Editar">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
      ${!isRealizado ? `
      <button class="icon-btn realizado" onclick="marcarRealizado('${c.id}')" title="Marcar como realizado">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
      </button>` : ''}
    </div></td>
  </tr>`;
}

const filterContacts = (q) => { S.searchQuery = q; contactos(); };
const filterFuente   = (f) => { S.filterFuente = f; contactos(); };

/* ── 10. ACTIVIDADES ────────────────────────────────────────── */

function actividades() {
  const filt    = S.filterActTipo;
  const todas   = (filt ? S.actividades.filter(a => a.tipo === filt) : [...S.actividades])
    .sort((a,b) => b.creadoEn - a.creadoEn);

  const pendientes  = todas.filter(a => !a.realizado);
  const realizadas  = todas.filter(a =>  a.realizado);

  const filterBtns = [['','Todas','🗂️'], ...Object.keys(ACT_ICONS).map(k => [k, ACT_LABELS[k], ACT_ICONS[k]])]
    .map(([id, lbl, icon]) => `<button class="filter-btn${filt===id?' active':''}" onclick="filterActTipo('${id}')">${icon} ${lbl}</button>`)
    .join('');

  let realizadasHTML = '';
  if (realizadas.length > 0) {
    realizadasHTML = `
    <div id="section-acts-realizadas" class="realizados-section">
      <div class="realizados-header">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        Realizados
        <span class="badge badge-neutral" style="font-size:10px">${realizadas.length}</span>
      </div>
      <div class="activity-feed">${realizadas.map(actItemHTML).join('')}</div>
    </div>`;
  }

  document.getElementById('content').innerHTML = `
  <div class="view-header" style="margin-bottom:12px">
    <span class="badge badge-neutral">${S.actividades.length} registros</span>
    <div style="display:flex;gap:8px">
      <button class="btn btn-ghost btn-sm" onclick="exportCSV('actividades')">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        CSV
      </button>
      <button class="btn btn-primary" onclick="openActividadModal()">+ Actividad</button>
    </div>
  </div>
  <div class="activity-filters">${filterBtns}</div>
  ${pendientes.length === 0 && realizadas.length === 0
    ? `<div class="empty"><div class="empty-icon">📋</div><p class="empty-title">Sin actividades</p><p class="empty-desc">Registra tu primera interacción.</p><button class="btn btn-primary" onclick="openActividadModal()">+ Actividad</button></div>`
    : `${pendientes.length > 0 ? `<div class="activity-feed">${pendientes.map(actItemHTML).join('')}</div>` : ''}
       ${realizadasHTML}`
  }`;
}

function actItemHTML(a) {
  const c = getContacto(a.contactoId);
  const esRealizado = !!a.realizado;
  return `<div class="activity-item${esRealizado ? ' act-realizada' : ''}">
    <div class="act-icon" style="background:${ACT_BG[a.tipo]||'#f8f9fb'}">${ACT_ICONS[a.tipo]||'📌'}</div>
    <div class="act-body">
      <div class="act-meta">
        <span class="act-contact">${escapeHTML(c?.nombre||'Contacto eliminado')}</span>
        <span class="act-type">${ACT_LABELS[a.tipo]||a.tipo}</span>
        <span class="act-time">${timeAgo(a.creadoEn)}</span>
        ${esRealizado ? `<span class="act-realizado-badge">✅ Realizado</span>` : ''}
      </div>
      <p class="act-desc">${escapeHTML(a.descripcion)}</p>
    </div>
    ${!esRealizado ? `
    <button class="icon-btn realizado" onclick="marcarActividadRealizada('${a.id}')" title="Marcar como realizado">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
    </button>` : ''}
  </div>`;
}

const filterActTipo = (t) => { S.filterActTipo = t; actividades(); };

/* ── 11. CONFIGURACIÓN ─────────────────────────────────────── */

function configuracion() {
  const cfg = S.config;
  const exportRow = (lbl, key, count) => `
  <div class="export-zone">
    <div><div class="export-label">${lbl}</div><div class="export-sublabel">${count} registros · CSV</div></div>
    <button class="btn btn-secondary" onclick="exportCSV('${key}')">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      Descargar
    </button>
  </div>`;

  document.getElementById('content').innerHTML = `
  <div class="config-grid">
    <div class="config-nav">
      <div style="font-size:11px;font-weight:600;color:var(--n-400);text-transform:uppercase;letter-spacing:.06em;padding:6px 12px;margin-bottom:4px">Secciones</div>
      <button class="config-nav-item active">🏢 Empresa</button>
      <button class="config-nav-item">📊 Pipeline</button>
      <button class="config-nav-item">📦 Exportar</button>
    </div>

    <div class="config-section">
      <div class="config-section-title">Datos de la empresa</div>
      <div class="card" style="display:flex;flex-direction:column;gap:16px">
        <div class="form-row">
          <div class="field">
            <label class="label" for="cfg-empresa">Empresa</label>
            <input type="text" id="cfg-empresa" class="input" value="${escapeHTML(cfg.empresa)}" placeholder="Tu empresa">
          </div>
          <div class="field">
            <label class="label" for="cfg-usuario">Tu nombre</label>
            <input type="text" id="cfg-usuario" class="input" value="${escapeHTML(cfg.usuario)}" placeholder="CEO / Dueño">
          </div>
        </div>
        <div class="field">
          <label class="label" for="cfg-whatsapp">WhatsApp de contacto (con lada)</label>
          <input type="tel" id="cfg-whatsapp" class="input" value="${escapeHTML(cfg.whatsapp||'')}" placeholder="5512345678">
        </div>
        <div><button class="btn btn-primary" onclick="saveConfig()">Guardar cambios</button></div>
      </div>

      <div class="config-section-title" style="margin-top:24px">Pipeline — 3 fases · 14 etapas</div>
      <div class="card">
        <div style="display:flex;flex-direction:column;gap:12px">
          ${FASES.map(fase => {
            const faseEtapas = ETAPAS.filter(e => e.fase === fase.id);
            return `
            <div>
              <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:${fase.bg};border-radius:8px;margin-bottom:4px">
                <span class="fase-num" style="background:${fase.color};font-size:10px;width:20px;height:20px">F${fase.n}</span>
                <span style="font-size:12px;font-weight:700;color:${fase.tc};text-transform:uppercase;letter-spacing:.05em">${fase.label}</span>
                <span style="font-size:11px;color:${fase.tc}88;margin-left:4px">${fase.desc}</span>
              </div>
              ${faseEtapas.map(e => `
              <div style="display:flex;align-items:center;gap:10px;padding:6px 10px 6px 20px;background:${e.bg};border-radius:6px;margin-bottom:3px">
                <span>${e.emoji}</span>
                <span style="font-size:12px;font-weight:600;color:${e.tc};flex:1">${e.label}</span>
                <span style="font-size:10px;color:${e.tc}88;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${e.gate}">${e.gate}</span>
                <span class="badge badge-neutral" style="font-size:10px">${dealsByEtapa(e.id).length} deals</span>
              </div>`).join('')}
            </div>`;
          }).join('')}
        </div>
        <p style="font-size:12px;color:var(--n-400);margin-top:10px">Edición visual de etapas disponible en Fase 2.</p>
      </div>

      <div class="config-section-title" style="margin-top:24px">Exportar datos</div>
      ${exportRow('Contactos',   'contactos',   S.contactos.length)}
      ${exportRow('Deals',       'deals',       S.deals.length)}
      ${exportRow('Actividades', 'actividades', S.actividades.length)}

      <div style="padding:14px 16px;background:var(--err-light);border-radius:10px;display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:8px">
        <div>
          <div style="font-size:13px;font-weight:600;color:var(--err-dark)">⚠️ Borrar todos los datos</div>
          <div style="font-size:12px;color:var(--err-dark)">Elimina contactos, deals y actividades permanentemente.</div>
        </div>
        <button class="btn btn-danger-outline" onclick="resetData()">Resetear CRM</button>
      </div>
    </div>
  </div>`;
}

function saveConfig() {
  S.config.empresa  = document.getElementById('cfg-empresa')?.value.trim()  || S.config.empresa;
  S.config.usuario  = document.getElementById('cfg-usuario')?.value.trim()  || S.config.usuario;
  S.config.whatsapp = document.getElementById('cfg-whatsapp')?.value.trim() || '';
  saveState();
  document.getElementById('sidebar-user-name').textContent = S.config.usuario;
  document.getElementById('sidebar-avatar').textContent    = initials(S.config.usuario);
  toast('Guardado', 'Datos de empresa actualizados.', 'success');
}

function resetData() {
  if (!confirm('¿Seguro? Esta acción borrará TODOS los contactos, deals y actividades.')) return;
  S.contactos = []; S.deals = []; S.actividades = [];
  saveState();
  navigate('dashboard');
  toast('CRM reiniciado', 'Todos los datos han sido eliminados.', 'warn');
}

/* ── 12. MODALES — control ─────────────────────────────────── */

function openModal(id) {
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('modal-overlay').removeAttribute('aria-hidden');
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
  document.getElementById(id)?.classList.remove('hidden');
}

function closeModal(id) {
  document.getElementById(id)?.classList.add('hidden');
  const anyOpen = [...document.querySelectorAll('.modal')].some(m => !m.classList.contains('hidden'));
  if (!anyOpen) closeAllModals();
}

function closeAllModals() {
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
  const ov = document.getElementById('modal-overlay');
  ov.classList.add('hidden');
  ov.setAttribute('aria-hidden', 'true');
  // Cerrar también el modal de perfil (no tiene clase .modal)
  document.getElementById('modal-mi-perfil')?.classList.add('hidden');
}

/* ── 13. MODAL — CONTACTO ──────────────────────────────────── */

function openContactoModal(id = null) {
  const c = id ? S.contactos.find(x => x.id === id) : null;
  document.getElementById('modal-contacto-title').textContent = c ? 'Editar Contacto' : 'Nuevo Contacto';
  document.getElementById('contacto-id').value = c?.id   || '';
  document.getElementById('c-nombre').value    = c?.nombre   || '';
  document.getElementById('c-empresa').value   = c?.empresa  || '';
  document.getElementById('c-whatsapp').value  = c?.whatsapp || '';
  document.getElementById('c-email').value     = c?.email    || '';
  document.getElementById('c-fuente').value    = c?.fuente   || 'Instagram';
  document.getElementById('c-monto').value     = c?.monto    || '';
  document.getElementById('c-notas').value     = c?.notas    || '';
  openModal('modal-contacto');
  setTimeout(() => document.getElementById('c-nombre').focus(), 80);
}

function saveContacto() {
  const nombre = document.getElementById('c-nombre').value.trim();
  const wa     = document.getElementById('c-whatsapp').value.trim();
  if (!nombre) { toast('Requerido', 'El nombre es obligatorio.', 'error'); return; }
  if (!wa)     { toast('Requerido', 'El WhatsApp es obligatorio.', 'error'); return; }

  const id  = document.getElementById('contacto-id').value;
  const now = Date.now();
  const data = {
    nombre,
    empresa:      document.getElementById('c-empresa').value.trim(),
    whatsapp:     wa,
    email:        document.getElementById('c-email').value.trim(),
    fuente:       document.getElementById('c-fuente').value,
    monto:        parseFloat(document.getElementById('c-monto').value) || 0,
    notas:        document.getElementById('c-notas').value.trim(),
    actualizadoEn:now,
  };

  if (id) {
    const i = S.contactos.findIndex(c => c.id === id);
    if (i >= 0) S.contactos[i] = { ...S.contactos[i], ...data };
    toast('Actualizado', nombre, 'success');
  } else {
    S.contactos.push({ id:'c'+uid(), creadoEn:now, ...data });
    toast('Contacto creado', nombre, 'success');
  }

  saveState(); closeAllModals();

  // Re-renderizar con la función correcta para el rol activo
  const isAdmin = AUTH.role === 'admin' || AUTH.role === 'ventas';
  if (S.view === 'contactos')  { isAdmin ? contactosAdmin()  : contactos(); }
  else if (S.view === 'dashboard') { isAdmin ? dashboardAdmin() : dashboard(); }
}

function deleteContacto(id) {
  const c = S.contactos.find(x => x.id === id);
  if (!c || !confirm(`¿Eliminar a ${c.nombre}? Sus deals y actividades también serán eliminados.`)) return;
  S.contactos   = S.contactos.filter(x => x.id !== id);
  S.deals       = S.deals.filter(d => d.contactoId !== id);
  S.actividades = S.actividades.filter(a => a.contactoId !== id);
  saveState(); closeAllModals();

  const _isAdmin = AUTH.role === 'admin' || AUTH.role === 'ventas';
  if (S.view === 'contactos') { _isAdmin ? contactosAdmin() : contactos(); }
  else navigate(S.view);
  toast('Eliminado', c.nombre, 'warn');
}

function marcarRealizado(id) {
  const c = S.contactos.find(x => x.id === id);
  if (!c) return;
  const now = Date.now();

  // Registrar actividad automática de "Realizado"
  S.actividades.push({
    id:          'a' + uid(),
    tipo:        'nota',
    contactoId:  id,
    descripcion: `✅ Gestión realizada con ${c.nombre}${c.empresa ? ' · ' + c.empresa : ''}.`,
    creadoEn:    now,
    realizado:   true,
    realizadoEn: now,
  });

  // Marcar el contacto como realizado y actualizar timestamp
  c.realizado   = true;
  c.realizadoEn = now;
  c.actualizadoEn = now;

  saveState();
  const _isAdminMR = AUTH.role === 'admin' || AUTH.role === 'ventas';
  if (S.view === 'contactos')  { _isAdminMR ? contactosAdmin()  : contactos();   }
  else if (S.view === 'actividades') { _isAdminMR ? actividadesAdmin() : actividades(); }

  // Scroll al apartado de realizados después del re-render
  setTimeout(() => {
    const sec = document.getElementById('section-contactos-realizados');
    if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 150);

  toast('✅ Realizado', c.nombre, 'success');
}

/* ── 14. MODAL — DEAL ──────────────────────────────────────── */

function openDealModal(id = null, etapaDefault = null) {
  const d = id ? S.deals.find(x => x.id === id) : null;

  document.getElementById('d-contacto').innerHTML =
    '<option value="">— Selecciona contacto —</option>' +
    S.contactos.map(c => `<option value="${c.id}"${d?.contactoId===c.id?' selected':''}>${escapeHTML(c.nombre)}</option>`).join('');

  document.getElementById('d-etapa').innerHTML =
    ETAPAS.map(e => `<option value="${e.id}"${(d?.etapa||etapaDefault||'prospecto_id')===e.id?' selected':''}>${e.emoji} ${e.label}</option>`).join('');

  document.getElementById('modal-deal-title').textContent = d ? 'Editar Deal' : 'Nuevo Deal';
  document.getElementById('deal-id').value     = d?.id            || '';
  document.getElementById('d-titulo').value    = d?.titulo        || '';
  document.getElementById('d-valor').value     = d?.valor         || '';
  document.getElementById('d-fecha').value     = d?.fechaLimite   || '';
  document.getElementById('d-proxima').value   = d?.proximaAccion || '';
  document.getElementById('d-notas').value     = d?.notas         || '';
  openModal('modal-deal');
  setTimeout(() => document.getElementById('d-titulo').focus(), 80);
}

function saveDeal() {
  const titulo     = document.getElementById('d-titulo').value.trim();
  const contactoId = document.getElementById('d-contacto').value;
  const valor      = parseFloat(document.getElementById('d-valor').value) || 0;
  if (!titulo)     { toast('Requerido','El título es obligatorio.','error'); return; }
  if (!contactoId) { toast('Requerido','Selecciona un contacto.','error');   return; }

  const id  = document.getElementById('deal-id').value;
  const now = Date.now();
  const data = {
    titulo, contactoId, valor,
    etapa:         document.getElementById('d-etapa').value,
    fechaLimite:   document.getElementById('d-fecha').value,
    proximaAccion: document.getElementById('d-proxima').value.trim(),
    notas:         document.getElementById('d-notas').value.trim(),
    actualizadoEn: now,
  };

  // Registrar inicio de onboarding al guardar desde el modal
  if (['ganado', 'onboarding'].includes(data.etapa)) {
    const existente = S.deals.find(d => d.id === id);
    if (!existente?.onboardingStartedAt) {
      data.onboardingStartedAt = now;
    }
  }

  if (id) {
    // ── Edición: actualizar deal ──────────────────────────────
    const i = S.deals.findIndex(d => d.id === id);
    if (i >= 0) S.deals[i] = { ...S.deals[i], ...data };
    toast('Deal actualizado', titulo, 'success');

    saveState(); closeAllModals();
    const _isAdminSD = AUTH.role === 'admin' || AUTH.role === 'ventas';
    if      (S.view === 'pipeline')    { _isAdminSD ? pipelineAdmin()    : pipeline();    }
    else if (S.view === 'dashboard')   { _isAdminSD ? dashboardAdmin()   : dashboard();   }
    else if (S.view === 'actividades') { _isAdminSD ? actividadesAdmin() : actividades(); }

  } else {
    // ── Nuevo deal: guardar + registrar actividad automática ──
    const newDealId = 'd' + uid();
    // Asignar vendedorId al perfil activo si es vendedor
    if (AUTH.role === 'venta' && AUTH.profileId) {
      data.vendedorId = AUTH.profileId;
    }
    S.deals.push({ id: newDealId, creadoEn: now, ...data });
    // ── Notificación deal nuevo → acumular en panel + enviar por WA ──
    const _perfilActivo = getProfileById(AUTH.role, AUTH.profileId);
    const _datosDeal = {
      titulo:               titulo,
      contacto:             data.contacto || getContacto(data.contactoId)?.nombre || 'Sin contacto',
      valor:                data.valor ? fmtMXN(data.valor) : 'No definido',
      proximaAccion:        data.proximaAccion || 'Sin definir',
      vendedor:             _perfilActivo?.nombre || 'Sin asignar',
      _vendedorProfileId:   AUTH.role === 'venta' ? AUTH.profileId : null,
    };
    acumularNotificacionSegmentada('deal_nuevo', _datosDeal, _perfilActivo);
    // Solo abrir WhatsApp si quien crea el deal es admin o director de ventas,
    // nunca cuando es un vendedor (role === 'venta')
    if (AUTH.role !== 'venta') {
      notificarWhatsApp('deal_nuevo', _datosDeal, 'admin');
      notificarWhatsApp('deal_nuevo', _datosDeal, 'ventas');
    }

    const etapaLabel = getEtapa(data.etapa).label;
    const partes = [
      `Deal creado: "${titulo}"`,
      `Etapa: ${etapaLabel}`,
      data.valor         ? `Valor: ${fmtMXN(data.valor)}`               : null,
      data.fechaLimite   ? `Fecha límite: ${fmtDate(data.fechaLimite)}` : null,
      data.proximaAccion ? `Próxima acción: ${data.proximaAccion}`       : null,
      data.notas         ? `Notas: ${data.notas}`                        : null,
    ].filter(Boolean);

    S.actividades.push({
      id:          'a' + uid(),
      tipo:        'nota',
      contactoId:  contactoId || null,
      descripcion: partes.join(' · '),
      creadoEn:    now,
    });

    // Actualizar timestamp del contacto
    if (contactoId) {
      const c = S.contactos.find(x => x.id === contactoId);
      if (c) c.actualizadoEn = now;
    }

    saveState(); closeAllModals();
    const _isAdminND = AUTH.role === 'admin' || AUTH.role === 'ventas';
    if      (S.view === 'pipeline')    { _isAdminND ? pipelineAdmin()  : (pipeline(), setTimeout(() => openDealDrawer(newDealId), 120)); }
    else if (S.view === 'dashboard')   { _isAdminND ? dashboardAdmin() : dashboard(); }
    else if (S.view === 'actividades') { _isAdminND ? actividadesAdmin() : actividades(); }

    toast('Deal creado', titulo, 'success');
  }

}

function deleteDeal(id) {
  const d = S.deals.find(x => x.id === id);
  if (!d || !confirm(`¿Eliminar el deal "${d.titulo}"?`)) return;
  S.deals = S.deals.filter(x => x.id !== id);
  saveState(); closeAllModals();
  const _isAdminDD = AUTH.role === 'admin' || AUTH.role === 'ventas';
  if (S.view === 'pipeline') { _isAdminDD ? pipelineAdmin() : pipeline(); }
  toast('Eliminado', d.titulo, 'warn');
}

/* ── 15. MODAL — ACTIVIDAD ─────────────────────────────────── */

function openActividadModal(preselContactoId = null) {
  document.getElementById('act-contacto').innerHTML =
    '<option value="">— Elige contacto —</option>' +
    S.contactos.map(c => `<option value="${c.id}"${preselContactoId===c.id?' selected':''}>${escapeHTML(c.nombre)}</option>`).join('');
  document.getElementById('act-descripcion').value = '';
  document.getElementById('act-tipo').value = 'whatsapp';
  openModal('modal-actividad');
  setTimeout(() => document.getElementById('act-descripcion').focus(), 80);
}

function saveActividad() {
  const desc = document.getElementById('act-descripcion').value.trim();
  if (!desc) { toast('Requerido', 'La descripción es obligatoria.', 'error'); return; }

  const now  = Date.now();
  const cid  = document.getElementById('act-contacto').value || null;
  const act  = { id:'a'+uid(), tipo:document.getElementById('act-tipo').value, contactoId:cid, descripcion:desc, creadoEn:now };
  S.actividades.push(act);

  if (cid) {
    const c = S.contactos.find(x => x.id === cid);
    if (c) c.actualizadoEn = now;
  }

  saveState(); closeAllModals();
  const _isAdminSA = AUTH.role === 'admin' || AUTH.role === 'ventas';
  if (S.view === 'actividades')  { _isAdminSA ? actividadesAdmin() : actividades();  }
  else if (S.view === 'dashboard') { _isAdminSA ? dashboardAdmin()  : dashboard();    }
  else if (S.view === 'pipeline')  { _isAdminSA ? pipelineAdmin()   : pipeline();     }
  toast('Actividad registrada', ACT_LABELS[act.tipo], 'success');
}

function deleteActividad(id) {
  S.actividades = S.actividades.filter(a => a.id !== id);
  saveState();
  const _isAdminDA = AUTH.role === 'admin' || AUTH.role === 'ventas';
  _isAdminDA ? actividadesAdmin() : actividades();
  toast('Eliminada', '', 'warn');
}

function marcarActividadRealizada(id) {
  const a = S.actividades.find(x => x.id === id);
  if (!a) return;
  a.realizado   = true;
  a.realizadoEn = Date.now();
  saveState();
  const _isAdminAR = AUTH.role === 'admin' || AUTH.role === 'ventas';
  _isAdminAR ? actividadesAdmin() : actividades();
  // Scroll al apartado realizados
  setTimeout(() => {
    const sec = document.getElementById('section-acts-realizadas');
    if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 150);
  toast('✅ Realizado', '', 'success');
}

/* ── DEAL DRAWER — Panel lateral de actividades ────────────── */

function openDealDrawer(dealId) {
  const d = S.deals.find(x => x.id === dealId);
  if (!d) return;
  const c = getContacto(d.contactoId);
  const e = getEtapa(d.etapa);

  // Header
  document.getElementById('drawer-deal-title').textContent = d.titulo;
  document.getElementById('drawer-deal-meta').innerHTML = `
    <span class="badge" style="background:${e.bg};color:${e.tc};font-size:10px">${e.emoji} ${e.label}</span>
    ${c ? `<span style="font-size:11px;color:var(--n-500)">· ${escapeHTML(c.nombre)}</span>` : ''}`;

  // Stats row
  const over = isOverdue(d.fechaLimite) && d.etapa !== 'ganado' && d.etapa !== 'perdido';
  document.getElementById('drawer-deal-stats').innerHTML = `
    <div class="drawer-stat">
      <div class="drawer-stat-val">${fmtMXN(d.valor)}</div>
      <div class="drawer-stat-lbl">Valor</div>
    </div>
    <div class="drawer-stat">
      <div class="drawer-stat-val" style="${over ? 'color:var(--error)' : ''}">${d.fechaLimite ? fmtDate(d.fechaLimite) : '—'}</div>
      <div class="drawer-stat-lbl">Fecha límite</div>
    </div>
    <div class="drawer-stat">
      <div class="drawer-stat-val" style="font-size:12px;color:var(--n-600)">${d.proximaAccion ? escapeHTML(d.proximaAccion.slice(0,22))+(d.proximaAccion.length>22?'…':'') : '—'}</div>
      <div class="drawer-stat-lbl">Próxima acción</div>
    </div>`;

  // Actividades del contacto
  const acts = c ? actsByContact(c.id) : [];
  document.getElementById('drawer-act-count').textContent = acts.length;

  document.getElementById('drawer-act-list').innerHTML = acts.length === 0
    ? `<div class="drawer-empty">
        <div class="drawer-empty-icon">📋</div>
        Sin actividades para este contacto.
        <br><button class="btn btn-secondary btn-sm" style="margin-top:12px" onclick="drawerAddActividad()">+ Primera actividad</button>
       </div>`
    : acts.map(a => `
        <div class="drawer-act-item">
          <div class="drawer-act-icon" style="background:${ACT_BG[a.tipo]||'#f8f9fb'}">${ACT_ICONS[a.tipo]||'📌'}</div>
          <div class="drawer-act-body">
            <div class="drawer-act-tipo">${ACT_LABELS[a.tipo]||a.tipo}</div>
            <div class="drawer-act-desc">${escapeHTML(a.descripcion)}</div>
            <div class="drawer-act-time">${timeAgo(a.creadoEn)}</div>
          </div>
        </div>`).join('');

  // Guardar referencias activas en el drawer
  document.getElementById('deal-drawer').dataset.dealId     = dealId;
  document.getElementById('deal-drawer').dataset.contactoId = d.contactoId || '';

  document.getElementById('deal-drawer').classList.add('open');
  document.getElementById('drawer-backdrop').classList.add('open');
}

function closeDealDrawer() {
  document.getElementById('deal-drawer').classList.remove('open');
  document.getElementById('drawer-backdrop').classList.remove('open');
  // Restaurar footer si estaba en modo admin
  const drawer = document.getElementById('deal-drawer');
  if (drawer.dataset.adminMode === '1') {
    drawer.dataset.adminMode = '';
    const btnAct  = document.getElementById('drawer-btn-actividad');
    const btnDeal = document.getElementById('drawer-btn-deal');
    if (btnAct)  btnAct.style.display = '';
    if (btnDeal) { btnDeal.textContent = 'Editar deal'; btnDeal.onclick = null; }
  }
}

function drawerAddActividad() {
  const cid = document.getElementById('deal-drawer').dataset.contactoId;
  closeDealDrawer();
  openActividadModal(cid || null);
}

function setupDrawer() {
  document.getElementById('drawer-close').addEventListener('click', closeDealDrawer);
  document.getElementById('drawer-backdrop').addEventListener('click', closeDealDrawer);
  document.getElementById('drawer-btn-actividad').addEventListener('click', drawerAddActividad);
  document.getElementById('drawer-btn-deal').addEventListener('click', () => {
    const did = document.getElementById('deal-drawer').dataset.dealId;
    closeDealDrawer();
    openDealModal(did);
  });
}

/* ── 16. MODAL — DETALLE CONTACTO ─────────────────────────── */

function openDetalleModal(cid) {
  const c = S.contactos.find(x => x.id === cid);
  if (!c) return;

  document.getElementById('detalle-nombre').textContent  = c.nombre;
  document.getElementById('detalle-empresa').textContent = c.empresa || '—';
  document.getElementById('detalle-avatar').textContent  = initials(c.nombre);

  // Info block
  document.getElementById('detalle-info-block').innerHTML = `
  <div>${[
    ['📱 WhatsApp', c.whatsapp||'—'],
    ['📧 Email',    c.email||'—'],
    ['🏢 Empresa',  c.empresa||'—'],
    ['📣 Fuente',   c.fuente||'—'],
    ['💰 Monto est.',fmtMXN(c.monto)],
    ['📅 Creado',   fmtDate(c.creadoEn)],
  ].map(([k,v]) => `<div class="info-row"><strong>${k}</strong><span>${escapeHTML(String(v))}</span></div>`).join('')}
  </div>
  ${c.notas ? `<div style="background:var(--n-50);border-radius:8px;padding:10px 12px;font-size:13px;color:var(--n-600);border:1px solid var(--n-200);margin-top:8px">${escapeHTML(c.notas)}</div>` : ''}`;

  // Deals block
  const deals = dealsByContact(cid);
  document.getElementById('detalle-deals-block').innerHTML = `
  <div class="detalle-col-title">Deals <span class="badge badge-neutral" style="font-size:10px">${deals.length}</span></div>
  ${deals.length === 0
    ? '<p style="font-size:12px;color:var(--n-400)">Sin deals registrados.</p>'
    : deals.map(d => {
        const e = getEtapa(d.etapa);
        return `<div style="display:flex;align-items:center;gap:8px;padding:8px;background:var(--n-50);border-radius:8px;border:1px solid var(--n-200);margin-bottom:6px">
          <div style="flex:1">
            <div style="font-size:13px;font-weight:600">${escapeHTML(d.titulo)}</div>
            <span class="badge" style="background:${e.bg};color:${e.tc};font-size:10px">${e.label}</span>
          </div>
          <div class="money" style="font-size:14px;font-weight:700;color:var(--indigo)">${fmtMXN(d.valor)}</div>
        </div>`;
      }).join('')
  }
  <button class="btn btn-secondary btn-sm" style="width:100%;margin-top:6px" onclick="openDealModal(null,null);setTimeout(()=>{document.getElementById('d-contacto').value='${cid}'},50)">+ Nuevo deal</button>`;

  // Activities
  const acts = actsByContact(cid).slice(0, 8);
  document.getElementById('detalle-act-list').innerHTML = acts.length === 0
    ? '<p style="font-size:12px;color:var(--n-400)">Sin actividades registradas.</p>'
    : acts.map(a => `<div class="act-mini">
        <div class="act-icon" style="background:${ACT_BG[a.tipo]||'#f8f9fb'}">${ACT_ICONS[a.tipo]||'📌'}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:11px;font-weight:600;color:var(--n-600)">${ACT_LABELS[a.tipo]||a.tipo}</div>
          <div class="act-desc">${escapeHTML(a.descripcion)}</div>
        </div>
        <div class="act-time">${timeAgo(a.creadoEn)}</div>
      </div>`).join('');

  // Footer button handlers
  document.getElementById('btn-edit-from-detalle').onclick    = () => { closeAllModals(); openContactoModal(cid); };
  document.getElementById('btn-delete-from-detalle').onclick  = () => deleteContacto(cid);
  document.getElementById('btn-add-act-detalle').onclick      = () => { closeAllModals(); openActividadModal(cid); };
  document.getElementById('btn-detalle-wa').onclick           = () => window.open(`https://wa.me/52${c.whatsapp}?text=Hola%20${encodeURIComponent(c.nombre)}%2C%20te%20contacto%20de%20NODE.`,'_blank','noopener');

  openModal('modal-detalle');
}

/* ── 17. EXPORTAR CSV ──────────────────────────────────────── */

function exportCSV(type) {
  let rows = [], filename = '';

  if (type === 'contactos') {
    filename = 'node-crm-contactos.csv';
    rows = [['ID','Nombre','Empresa','WhatsApp','Email','Fuente','Monto MXN','Notas','Creado']];
    S.contactos.forEach(c => rows.push([c.id, c.nombre, c.empresa, c.whatsapp, c.email, c.fuente, c.monto, c.notas, fmtDate(c.creadoEn)]));
  } else if (type === 'deals') {
    filename = 'node-crm-deals.csv';
    rows = [['ID','Título','Contacto','Valor MXN','Etapa','Fecha Límite','Próxima Acción','Notas']];
    S.deals.forEach(d => rows.push([d.id, d.titulo, getContacto(d.contactoId)?.nombre||'', d.valor, getEtapa(d.etapa).label, d.fechaLimite, d.proximaAccion, d.notas]));
  } else if (type === 'actividades') {
    filename = 'node-crm-actividades.csv';
    rows = [['ID','Tipo','Contacto','Descripción','Fecha']];
    S.actividades.forEach(a => rows.push([a.id, ACT_LABELS[a.tipo]||a.tipo, getContacto(a.contactoId)?.nombre||'', a.descripcion, fmtDate(a.creadoEn)]));
  }

  const csv  = rows.map(r => r.map(v => `"${String(v||'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob(['\uFEFF'+csv], { type:'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href:url, download:filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('CSV exportado', filename, 'success');
}

/* ── 18. BÚSQUEDA ──────────────────────────────────────────── */

function setupSearch() {
  const inp = document.getElementById('global-search');

  inp.addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    q ? showSearchResults(q) : closeSearchDropdown();
  });

  inp.addEventListener('keydown', e => {
    if (e.key === 'Escape') { inp.value = ''; closeSearchDropdown(); inp.blur(); }
  });

  document.addEventListener('click', e => {
    if (!inp.closest('.search-wrap').contains(e.target)) closeSearchDropdown();
  });
}

function showSearchResults(q) {
  closeSearchDropdown();
  const contacts = S.contactos.filter(c => `${c.nombre} ${c.empresa}`.toLowerCase().includes(q)).slice(0, 4);
  const deals    = S.deals.filter(d => d.titulo.toLowerCase().includes(q)).slice(0, 3);
  if (!contacts.length && !deals.length) return;

  const box = document.createElement('div');
  box.className = 'search-results'; box.id = 'search-dropdown';
  let html = '';

  if (contacts.length) {
    html += '<div class="sr-section">Contactos</div>';
    contacts.forEach(c => {
      html += `<div class="sr-item" onclick="openDetalleModal('${c.id}');closeSearchDropdown()">
        <div style="width:26px;height:26px;border-radius:50%;background:var(--indigo-100);color:var(--indigo);font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0">${initials(c.nombre)}</div>
        <span style="flex:1">${escapeHTML(c.nombre)}</span>
        <span style="font-size:11px;color:var(--n-400)">${escapeHTML(c.empresa||'')}</span>
        <span class="sr-tag">Contacto</span>
      </div>`;
    });
  }
  if (deals.length) {
    html += '<div class="sr-section">Deals</div>';
    deals.forEach(d => {
      const e = getEtapa(d.etapa);
      html += `<div class="sr-item" onclick="openDealModal('${d.id}');closeSearchDropdown()">
        <span style="flex:1">${escapeHTML(d.titulo)}</span>
        <span class="sr-tag" style="background:${e.bg};color:${e.tc}">${e.label}</span>
      </div>`;
    });
  }

  box.innerHTML = html;
  document.querySelector('.search-wrap').appendChild(box);
}

const closeSearchDropdown = () => document.getElementById('search-dropdown')?.remove();

/* ── 19. MENÚ RÁPIDO ───────────────────────────────────────── */

function setupQuickMenu() {
  const btn  = document.getElementById('btn-quick-add');
  const menu = document.getElementById('quick-menu');

  btn.addEventListener('click', e => {
    e.stopPropagation();
    const r = btn.getBoundingClientRect();
    menu.style.top   = (r.bottom + 6) + 'px';
    menu.style.right = (window.innerWidth - r.right) + 'px';
    menu.classList.toggle('hidden');
  });

  document.getElementById('qa-contacto')?.addEventListener('click', () => { closeQuickMenu(); openContactoModal(); });
  document.getElementById('qa-deal')?.addEventListener('click',     () => { closeQuickMenu(); openDealModal(); });
  document.getElementById('qa-actividad')?.addEventListener('click',() => { closeQuickMenu(); openActividadModal(); });

  document.addEventListener('click', closeQuickMenu);
}

const closeQuickMenu = () => document.getElementById('quick-menu')?.classList.add('hidden');

/* ── 20. ATAJOS DE TECLADO ─────────────────────────────────── */

function setupKeyboard() {
  document.addEventListener('keydown', e => {
    const inField = ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);

    // Alt + 1–5 — navegación
    if (e.altKey && e.key >= '1' && e.key <= '5') {
      e.preventDefault();
      const v = ['dashboard','pipeline','contactos','actividades','configuracion'][+e.key - 1];
      if (v) navigate(v);
      return;
    }

    // Esc — cerrar todo
    if (e.key === 'Escape') {
      closeAllModals(); closeQuickMenu(); closeDealDrawer();
      document.getElementById('shortcuts-panel')?.classList.add('hidden');
      closeSearchDropdown();
      return;
    }

    if (inField) return;

    switch (e.key) {
      case '?': document.getElementById('shortcuts-panel')?.classList.toggle('hidden'); break;
      case 'n': case 'N': openContactoModal(); break;
      case 'd': case 'D': openDealModal();     break;
      case 'a': case 'A': openActividadModal();break;
      default:
        if ((e.ctrlKey||e.metaKey) && e.key==='k') {
          e.preventDefault();
          document.getElementById('global-search').focus();
        }
    }
  });
}

/* ── 21. TOASTS ────────────────────────────────────────────── */

function toast(title, msg='', type='success') {
  const ICONS = { success:'✅', error:'❌', warn:'⚠️', info:'ℹ️' };
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `
    <span class="toast-icon">${ICONS[type]||'📌'}</span>
    <div class="toast-body">
      <div class="toast-title">${escapeHTML(title)}</div>
      ${msg ? `<div class="toast-msg">${escapeHTML(msg)}</div>` : ''}
    </div>`;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 250); }, 3500);
}

/* ── 22. WIRING ────────────────────────────────────────────── */
/* ── RELOJ EN TIEMPO REAL ── */
function setupClock() {
  const DIAS   = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  const MESES  = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

  function tick() {
    const now  = new Date();
    const hh   = String(now.getHours()).padStart(2,'0');
    const mm   = String(now.getMinutes()).padStart(2,'0');
    const ss   = String(now.getSeconds()).padStart(2,'0');
    const dia  = DIAS[now.getDay()];
    const fecha= `${dia} ${now.getDate()} ${MESES[now.getMonth()]} ${now.getFullYear()}`;

    const elTime = document.getElementById('clock-time');
    const elDate = document.getElementById('clock-date');
    if (elTime) elTime.textContent = `${hh}:${mm}:${ss}`;
    if (elDate) elDate.textContent = fecha;
  }

  tick(); // mostrar inmediatamente
  // Actualizar cada segundo
  if (window._clockInterval) clearInterval(window._clockInterval);
  window._clockInterval = setInterval(tick, 1000);
}

function wireUpButtons() {
  // Cierre de sesión
  document.getElementById('btn-logout')?.addEventListener('click', logout);
  // Sidebar nav
  document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.view));
  });

  // Modal close — data-close buttons
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });

  // Modal overlay click-outside
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeAllModals();
  });

  // Save buttons
  document.getElementById('btn-save-contacto')?.addEventListener('click', saveContacto);
  document.getElementById('btn-save-deal')?.addEventListener('click',     saveDeal);
  document.getElementById('btn-save-actividad')?.addEventListener('click', saveActividad);

  // Enter inside forms (except textarea)
  document.querySelectorAll('.modal form').forEach(form => {
    form.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault();
        form.closest('.modal')?.querySelector('.btn-primary')?.click();
      }
    });
  });

  // Shortcuts panel
  document.getElementById('btn-shortcuts')?.addEventListener('click', () => {
    document.getElementById('shortcuts-panel')?.classList.toggle('hidden');
  });
  document.getElementById('shortcuts-close')?.addEventListener('click', () => {
    document.getElementById('shortcuts-panel')?.classList.add('hidden');
  });
  document.getElementById('shortcuts-backdrop')?.addEventListener('click', () => {
    document.getElementById('shortcuts-panel')?.classList.add('hidden');
  });

  // Deal drawer
  setupDrawer();
  // Panel de notificaciones
  setupNotifPanel();
}

/* ── 23. INIT ──────────────────────────────────────────────── */

function init() {

  setupLoginScreen();

  // Restaurar sesión activa (recarga de pestaña)
  if (restoreSession()) {
    // Con sesión activa: cargar datos del rol correcto DESPUÉS de conocer el rol
    const hasData = loadState();
    if (!hasData && (AUTH.role === 'admin' || AUTH.role === 'ventas')) {
      seedData();
    }

    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    // Asegurar que el login quede en paso 1 por si se recarga
    document.getElementById('login-step-1')?.classList.remove('hidden');
    document.getElementById('login-step-2')?.classList.add('hidden');

    applyRole();
    wireUpButtons();
    setupSearch();
    setupQuickMenu();
    setupKeyboard();
    setupClock();

    // Navegar a primera vista permitida del rol restaurado
    const firstView = ROLE_VIEWS[AUTH.role]?.[0] || 'pipeline';
    navigate(firstView);

    // Revisar notificaciones al cargar + cada 30 minutos
    setTimeout(checkNotificaciones, 2000);
    setInterval(checkNotificaciones, 30 * 60 * 1000);

  } else {
    // Sin sesión: precargar datos globales de ejemplo si no existen
    // Los vendedores (venta) NO precargan nada — sus datos se cargan en loginStep2
    const globalRaw = localStorage.getItem(STORAGE_KEY);
    if (!globalRaw) {
      // Seed de datos de muestra para admin/ventas (seedData ignora role=venta por diseño)
      seedData();
      // Guardar sin contaminar S — limpiar S después
      S.contactos = []; S.deals = []; S.actividades = [];
    }

    // Sin sesión → mostrar login
    document.getElementById('login-screen').classList.remove('hidden');
    document.getElementById('app').classList.add('hidden');
  }
}
//SISTEMA DE NOTIFICACIONES DE NODE
/**
 * @param{string} tel numero con lada 
 * @param{string} mensaje mensaje que se mandara
 */
function enviarWhatsApp(tel,mensaje){
  if(!tel) {
    console.warn('enviarWhatsApp: numero no definido');
    return;
  }
  const url = `https://wa.me/${tel.replace(/[\s\-\+]/g, '')}?text=${encodeURIComponent(mensaje)}`;
  window.open(url, '_blank', 'noopener,noreferrer')
}
/**
 * PIEZA 2 — Constructor de mensajes
 * Recibe el tipo de evento y los datos del deal,
 * regresa el texto listo para enviar por WhatsApp.
 */
function construirMensajeWa(tipo, datos) {
  const empresa = S.config.empresa || 'NODE CRM';
  const hoy     = new Date().toLocaleDateString('es-MX', { 
    day:'2-digit', month:'short', year:'numeric' 
  });

  const plantillas = {

    // Evento 1 — Deal nuevo creado
    deal_nuevo: `🆕 *${empresa}*
📅 ${hoy}

Un cliente solicitó un servicio:
• Deal: ${datos.titulo}
• Cliente: ${datos.contacto}
• Valor: ${datos.valor}
• Próxima acción: ${datos.proximaAccion}
• 👤 Generado por: ${datos.vendedor || 'Sin asignar'}

Entra al CRM para dar seguimiento.`,

    // Evento 0 — Prospecto nuevo desde formulario web
    prospecto_nuevo: `🙋 *${empresa}*
📅 ${hoy}

¡Nuevo prospecto registrado desde el formulario web!
• Nombre: ${datos.contacto}
• Interés: ${datos.proximaAccion}
• 📥 Fuente: Formulario web (auto-registro)

Asigna a un vendedor y da seguimiento.`,

    // Evento 2 — Reunión próxima (fecha límite cercana)
    reunion_proxima: `📅 *${empresa}*
⚠️ Reunión próxima

- Deal: ${datos.titulo}
- Cliente: ${datos.contacto}
- Fecha límite: ${datos.fechaLimite}
- Faltan: ${datos.diasRestantes} día(s)
- Próxima acción: ${datos.proximaAccion}

Prepárate para la reunión.`,

    // Evento 3 — Deal sin actividad
    sin_actividad: `⚠️ *${empresa}*
😴 Deal sin actividad

- Deal: ${datos.titulo}
- Cliente: ${datos.contacto}
- Días sin actividad: ${datos.diasSinActividad}
- Última acción: ${datos.ultimaAccion}

Retoma el contacto hoy.`,

  };

  return plantillas[tipo] || `📌 ${empresa}: Notificación del CRM — ${hoy}`;
}
/**
 * notificar a la central el deal con los numeros registrados
 * @param {string} tipo -deal nuevo,reunion proxima.sin actividad
 * @param {object} datos -datos deal que se dispara
 * @param {string} rol -rol que recibe la notificacion
 */
function notificarWhatsApp(tipo, datos, rol = null){
  const mensaje = construirMensajeWa(tipo, datos);
  const perfiles = getProfiles ();
  // RECORRER LOS ROLES O INDICADO
  const rolesANotificar = rol ?[rol] : Object.keys(perfiles);
  rolesANotificar.forEach(r => {
    perfiles[r].forEach(perfil => {
      if (perfil.tel) {
        enviarWhatsApp(perfil.tel, mensaje);
      }
    });
  }); 
}

/* ═══════════════════════════════════════════════════════════════
   PANEL DE NOTIFICACIONES PENDIENTES (segmentado por rol/perfil)
   ═══════════════════════════════════════════════════════════════ */

/* NOTA: getNotifDe / saveNotifDe / acumularNotificacionSegmentada
   están definidas arriba junto a ROLE_VIEWS */

/* ── Helpers de compatibilidad para el panel ── */
function getNotifPendientes() {
  return getNotifDelUsuarioActual();
}
function saveNotifPendientes(lista) {
  saveNotifDelUsuarioActual(lista);
}

/** @deprecated — usar acumularNotificacionSegmentada */
function acumularNotificacion(tipo, datos, perfilOrigen) {
  acumularNotificacionSegmentada(tipo, datos, perfilOrigen);
}

/* ── Actualizar el badge contador de la campana ── */
function actualizarBadge() {
  const lista    = getNotifPendientes().filter(n => !n.enviada);
  const badge    = document.getElementById('notif-bell-count');
  const bell     = document.getElementById('btn-notif-bell');
  const countEl  = document.getElementById('notif-panel-count');
  const total    = lista.length;

  if (badge) {
    badge.textContent = total > 99 ? '99+' : total;
    badge.classList.toggle('hidden', total === 0);
  }
  if (bell) bell.classList.toggle('has-notif', total > 0);
  if (countEl) countEl.textContent = total;
}

/* ── Renderizar el panel ── */
function renderNotifPanel() {
  const lista   = getNotifPendientes();
  const listEl  = document.getElementById('notif-list');
  const emptyEl = document.getElementById('notif-empty');
  if (!listEl) return;

  const pendientes = lista.filter(n => !n.enviada);

  if (pendientes.length === 0) {
    listEl.innerHTML = '';
    emptyEl?.classList.remove('hidden');
    return;
  }
  emptyEl?.classList.add('hidden');

  const TIPO_META = {
    reunion_proxima: { label: '📅 Reunión próxima',       cls: 'reunion'       },
    sin_actividad:   { label: '😴 Sin actividad',          cls: 'sinactividad'  },
    deal_nuevo:      { label: '🆕 Deal nuevo',             cls: 'deal_nuevo'    },
    prospecto_nuevo: { label: '🙋 Nuevo prospecto',        cls: 'deal_nuevo'    },
  };

  // Encabezado del panel según el rol
  const ROLE_NOTIF_LABELS = {
    admin:  '👑 Admin — Todas las notificaciones',
    ventas: '📈 Director — Todas las notificaciones',
    venta:  '🎯 Mis notificaciones',
  };
  const panelTitleEl = document.querySelector('.notif-panel-title');
  if (panelTitleEl) {
    const roleLabel = ROLE_NOTIF_LABELS[AUTH.role] || 'Notificaciones';
    const subEl = panelTitleEl.querySelector('.notif-role-sub') || (() => {
      const s = document.createElement('span');
      s.className = 'notif-role-sub';
      panelTitleEl.appendChild(s);
      return s;
    })();
    subEl.textContent = ' · ' + roleLabel;
  }

  listEl.innerHTML = pendientes.map(n => {
    const meta    = TIPO_META[n.tipo] || { label: '📌 Alerta', cls: 'reunion' };
    const tiempo  = timeAgo(n.ts);
    const perfil  = n.perfil;

    // Detalle según tipo
    let detalle = '';
    if (n.tipo === 'reunion_proxima') {
      detalle = `Fecha: ${n.datos.fechaLimite} · Faltan ${n.datos.diasRestantes} día(s)<br>Acción: ${escapeHTML(n.datos.proximaAccion || '—')}`;
    } else if (n.tipo === 'sin_actividad') {
      detalle = `${n.datos.diasSinActividad} días sin actividad<br>Última acción: ${escapeHTML(n.datos.ultimaAccion || '—')}`;
    } else if (n.tipo === 'deal_nuevo') {
      detalle = `Valor: ${n.datos.valor}<br>Acción: ${escapeHTML(n.datos.proximaAccion || '—')}`;
    } else if (n.tipo === 'prospecto_nuevo') {
      detalle = `Fuente: Formulario web<br>Interés: ${escapeHTML(n.datos.proximaAccion || '—')}`;
    }

    // Vendedor asignado (si aplica — visible en admin/ventas)
    const vendedorHTML = (AUTH.role === 'admin' || AUTH.role === 'ventas') && n.datos?.vendedor
      ? `<div class="notif-card-vendedor">
           <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
           Vendedor: <strong>${escapeHTML(n.datos.vendedor)}</strong>
         </div>`
      : '';

    // Card del perfil origen
    const perfilHTML = perfil ? `
      <div class="notif-card-perfil">
        <div class="notif-card-perfil-avatar">${initials(perfil.nombre)}</div>
        <div class="notif-card-perfil-info">
          Generado por <strong>${escapeHTML(perfil.nombre)}</strong>
          · ${escapeHTML(perfil.cargo || perfil.rol || '')}
        </div>
      </div>` : '';

    return `
      <div class="notif-card" data-notif-id="${n.id}">
        <div class="notif-card-header">
          <span class="notif-card-tipo ${meta.cls}">${meta.label}</span>
          <span class="notif-card-time">${tiempo}</span>
        </div>
        <div class="notif-card-body">
          <div class="notif-card-deal">${escapeHTML(n.datos.titulo || n.datos.contacto || '—')}</div>
          <div class="notif-card-cliente">👤 ${escapeHTML(n.datos.contacto || '—')}</div>
          <div class="notif-card-detail">${detalle}</div>
        </div>
        ${vendedorHTML}
        ${perfilHTML}
        <div class="notif-card-footer">
          <button class="notif-btn-send" onclick="enviarNotifWA('${n.id}')">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M11.999 0C5.373 0 0 5.373 0 12c0 2.117.553 4.103 1.519 5.831L0 24l6.335-1.663A11.945 11.945 0 0 0 12 24c6.627 0 12-5.373 12-12S18.626 0 11.999 0zm.001 21.818a9.814 9.814 0 0 1-5.001-1.371l-.358-.214-3.724.977.995-3.63-.235-.374A9.82 9.82 0 0 1 2.18 12c0-5.418 4.402-9.818 9.82-9.818 5.418 0 9.818 4.4 9.818 9.818 0 5.417-4.4 9.818-9.818 9.818z"/></svg>
            Enviar por WhatsApp
          </button>
          <button class="notif-btn-dismiss" onclick="dismissNotif('${n.id}')" title="Descartar">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>`;
  }).join('');
}

/* ── Abrir / cerrar panel ── */
function toggleNotifPanel() {
  const panel    = document.getElementById('notif-panel');
  const backdrop = document.getElementById('notif-backdrop');
  const isOpen   = !panel.classList.contains('hidden');

  if (isOpen) {
    panel.classList.add('hidden');
    backdrop.classList.add('hidden');
  } else {
    renderNotifPanel();
    panel.classList.remove('hidden');
    backdrop.classList.remove('hidden');
  }
}

function cerrarNotifPanel() {
  document.getElementById('notif-panel')?.classList.add('hidden');
  document.getElementById('notif-backdrop')?.classList.add('hidden');
}

/* ── Enviar una notificación individual por WhatsApp ── */
function enviarNotifWA(notifId) {
  const lista  = getNotifPendientes();
  const notif  = lista.find(n => n.id === notifId);
  if (!notif) return;

  const mensaje = construirMensajeWa(notif.tipo, {
    ...notif.datos,
    vendedor: notif.perfil?.nombre || notif.datos?.vendedor || 'Sin asignar',
  });

  // Determinar destinatarios WA según el rol del usuario activo
  let perfilesWA = [];
  if (AUTH.role === 'admin') {
    // Admin envía a todos los admins con número
    perfilesWA = (getProfiles()['admin'] || []).filter(p => p.tel);
  } else if (AUTH.role === 'ventas') {
    // Director de ventas envía a todos los directores con número
    perfilesWA = (getProfiles()['ventas'] || []).filter(p => p.tel);
  } else if (AUTH.role === 'venta') {
    // Vendedor individual envía a sí mismo
    const propio = getProfileById('venta', AUTH.profileId);
    if (propio?.tel) perfilesWA = [propio];
  }

  if (perfilesWA.length === 0) {
    toast('Sin número', 'Agrega un teléfono a tu perfil para enviar notificaciones.', 'warn');
    return;
  }

  perfilesWA.forEach((p, i) => {
    setTimeout(() => enviarWhatsApp(p.tel, mensaje), i * 600);
  });

  // Marcar como enviada en el buzón del usuario activo
  notif.enviada = true;
  saveNotifPendientes(lista);
  actualizarBadge();

  const card = document.querySelector(`.notif-card[data-notif-id="${notifId}"]`);
  if (card) {
    card.style.opacity = '0.4';
    card.style.transition = 'opacity 300ms';
    setTimeout(() => { renderNotifPanel(); actualizarBadge(); }, 500);
  }

  toast('WhatsApp abierto', `Enviando a ${perfilesWA.length} número(s).`, 'success');
}

/* ── Enviar TODAS las notificaciones pendientes ── */
function enviarTodasNotif() {
  const lista = getNotifPendientes().filter(n => !n.enviada);
  if (lista.length === 0) {
    toast('Sin pendientes', 'No hay notificaciones por enviar.', 'info');
    return;
  }

  let perfilesWA = [];
  if (AUTH.role === 'admin') {
    perfilesWA = (getProfiles()['admin'] || []).filter(p => p.tel);
  } else if (AUTH.role === 'ventas') {
    perfilesWA = (getProfiles()['ventas'] || []).filter(p => p.tel);
  } else if (AUTH.role === 'venta') {
    const propio = getProfileById('venta', AUTH.profileId);
    if (propio?.tel) perfilesWA = [propio];
  }

  if (perfilesWA.length === 0) {
    toast('Sin número', 'Agrega un teléfono a tu perfil para enviar notificaciones.', 'warn');
    return;
  }

  let delay = 0;
  lista.forEach(notif => {
    const mensaje = construirMensajeWa(notif.tipo, {
      ...notif.datos,
      vendedor: notif.perfil?.nombre || notif.datos?.vendedor || 'Sin asignar',
    });
    perfilesWA.forEach(p => {
      setTimeout(() => enviarWhatsApp(p.tel, mensaje), delay);
      delay += 700;
    });
  });

  // Marcar todas como enviadas
  const all = getNotifPendientes();
  const ids = new Set(lista.map(n => n.id));
  all.forEach(n => { if (ids.has(n.id)) n.enviada = true; });
  saveNotifPendientes(all);

  setTimeout(() => { renderNotifPanel(); actualizarBadge(); }, 400);
  toast('Enviando', `${lista.length} notificaciones abiertas en WhatsApp.`, 'success');
}

/* ── Descartar una notificación ── */
function dismissNotif(notifId) {
  const lista = getNotifPendientes();
  const n     = lista.find(x => x.id === notifId);
  if (n) { n.enviada = true; saveNotifPendientes(lista); }
  renderNotifPanel();
  actualizarBadge();
}

/* ── Limpiar todas (marcar enviadas) ── */
function limpiarNotifs() {
  const lista = getNotifPendientes().map(n => ({ ...n, enviada: true }));
  saveNotifPendientes(lista);
  renderNotifPanel();
  actualizarBadge();
  toast('Listo', 'Notificaciones marcadas como leídas.', 'success');
}

/* ── Setup del panel (llamar en wireUpButtons) ── */
function setupNotifPanel() {
  document.getElementById('btn-notif-bell')?.addEventListener('click', toggleNotifPanel);
  document.getElementById('btn-close-notif')?.addEventListener('click', cerrarNotifPanel);
  document.getElementById('notif-backdrop')?.addEventListener('click', cerrarNotifPanel);
  document.getElementById('btn-send-all-notif')?.addEventListener('click', enviarTodasNotif);
  document.getElementById('btn-clear-notif')?.addEventListener('click', limpiarNotifs);
  // Actualizar badge al cargar
  actualizarBadge();
}

document.addEventListener('DOMContentLoaded', init);
/* ═══════════════════════════════════════════════════════════════
   MODAL MI PERFIL
   ═══════════════════════════════════════════════════════════════ */

function abrirModalPerfil() {
  const role      = AUTH.role;
  const profileId = AUTH.profileId;
  if (role === 'prospecto') return;
  const profile   = getProfileById(role, profileId);
  if (!profile) return;

  document.getElementById('perfil-modal-avatar').textContent = initials(profile.nombre);
  document.getElementById('perfil-modal-nombre').textContent = profile.nombre;
  document.getElementById('perfil-modal-cargo').textContent  = profile.cargo;
  document.getElementById('perfil-modal-rol').textContent    =
    role === 'admin' ? '👑 Administrador' :
    role === 'ventas' ? '📈 Director de Ventas' : '🎯 Venta NODE';
  document.getElementById('perfil-tel').value   = profile.tel   || '';
  document.getElementById('perfil-email').value = profile.email || '';

  document.getElementById('modal-mi-perfil').classList.remove('hidden');
  setTimeout(() => document.getElementById('perfil-tel').focus(), 80);
}

function guardarMiPerfil() {
  const role      = AUTH.role;
  const profileId = AUTH.profileId;
  const tel       = document.getElementById('perfil-tel').value.trim().replace(/[\s\-\+]/g, '');
  const email     = document.getElementById('perfil-email').value.trim();

  if (tel && !/^[0-9]{12,13}$/.test(tel)) {
    toast('Teléfono inválido', 'Debe tener 12 o 13 dígitos sin espacios. Ej: 5215512345678', 'error');
    return;
  }

  const profiles = getProfiles();
  const perfil   = profiles[role]?.find(p => p.id === profileId);
  if (!perfil) return;

  perfil.tel   = tel;
  perfil.email = email;
  saveProfiles(profiles);

  // Actualizar sidebar en tiempo real
  const telEl   = document.getElementById('sidebar-user-tel');
  const emailEl = document.getElementById('sidebar-user-email');
  if (telEl)   { telEl.textContent = tel;   telEl.parentElement?.classList.toggle('hidden', !tel);   }
  if (emailEl) { emailEl.textContent = email; emailEl.parentElement?.classList.toggle('hidden', !email); }

  closeAllModals();
  toast('Perfil actualizado', 'Tu número y correo han sido guardados.', 'success');
}

/* ═══════════════════════════════════════════════════════════════
   DETECTORES DE EVENTOS — NOTIFICACIONES AUTOMÁTICAS
   ═══════════════════════════════════════════════════════════════ */

/**
 * Revisa todos los deals activos y dispara notificaciones WA si:
 *  1. La fecha límite es en 1 o 2 días (reunión próxima)
 *  2. El deal lleva 3+ días sin actividad (sin_actividad)
 * Se llama al cargar el CRM y cada 30 minutos.
 */
/**
 * Revisa todos los deals activos y dispara notificaciones WA si:
 *  1. La fecha límite es en 1 o 2 días (reunión próxima)
 *  2. El deal lleva 3+ días sin actividad (sin_actividad)
 * Segmentación:
 *  - Admin y Director ven TODAS las alertas
 *  - Cada vendedor (venta) solo ve alertas de SUS deals
 * Se llama al cargar el CRM y cada 30 minutos.
 */
async function checkNotificaciones() {
  const ahora    = Date.now();
  const MS_DIA   = 86_400_000;
  const etapasIgnorar = ['ganado', 'perdido'];

  // Clave única por día para evitar duplicados
  const HOY_KEY  = 'node_notif_check_' + new Date().toISOString().slice(0, 10);
  let   enviados = await sbGet(HOY_KEY) || [];

  // Determinar qué deals revisar:
  // - admin/ventas: todos los deals globales (S.deals ya los tiene)
  // - venta: solo deals de S.deals (que son sus propios)
  S.deals.forEach(deal => {
    if (etapasIgnorar.includes(deal.etapa)) return;

    const contacto    = S.contactos.find(c => c.id === deal.contactoId);
    const nomContacto = contacto?.nombre || 'Sin contacto';

    // Perfil del vendedor dueño del deal
    const vendedorProfileId = deal.vendedorId || null;
    const perfilVendedor    = vendedorProfileId
      ? getProfileById('venta', vendedorProfileId)
      : null;

    // El perfil "origen" que aparecerá en la notificación
    const perfilOrigen = perfilVendedor || (AUTH.profileId ? getProfileById(AUTH.role, AUTH.profileId) : null);

    // ── Detector 1: Reunión próxima ──────────────────────────
    if (deal.fechaLimite) {
      const limite        = new Date(deal.fechaLimite).getTime();
      const diasRestantes = Math.ceil((limite - ahora) / MS_DIA);
      const keyReunion    = `reunion_${deal.id}_${diasRestantes}d`;

      if ((diasRestantes === 1 || diasRestantes === 2) && !enviados.includes(keyReunion)) {
        const datos = {
          titulo:              deal.titulo,
          contacto:            nomContacto,
          fechaLimite:         fmtDate(deal.fechaLimite),
          diasRestantes,
          proximaAccion:       deal.proximaAccion || 'Sin definir',
          vendedor:            perfilOrigen?.nombre || 'Sin asignar',
          _vendedorProfileId:  vendedorProfileId,
        };
        acumularNotificacionSegmentada('reunion_proxima', datos, perfilOrigen);
        enviados.push(keyReunion);
      }
    }

    // ── Detector 2: Deal sin actividad (3+ días) ────────────
    const ultimaAct  = deal.actualizadoEn || deal.creadoEn;
    const diasSinAct = Math.floor((ahora - ultimaAct) / MS_DIA);
    const keySinAct  = `sinact_${deal.id}_${Math.floor(diasSinAct / 3)}`;

    if (diasSinAct >= 3 && !enviados.includes(keySinAct)) {
      const datos = {
        titulo:             deal.titulo,
        contacto:           nomContacto,
        diasSinActividad:   diasSinAct,
        ultimaAccion:       deal.proximaAccion || 'Sin registrar',
        vendedor:           perfilOrigen?.nombre || 'Sin asignar',
        _vendedorProfileId: vendedorProfileId,
      };
      acumularNotificacionSegmentada('sin_actividad', datos, perfilOrigen);
      enviados.push(keySinAct);
    }
  });

  // Si es admin/ventas, también revisar deals de TODOS los vendedores
  // (sus stores privados) para tener visibilidad completa
  if (AUTH.role === 'admin' || AUTH.role === 'ventas') {
    const todosVendedores = DEFAULT_PROFILES['venta'] || [];
    for (const vendedor of todosVendedores) {
      const vd = await getVendedorData(vendedor.id);
      (vd.deals || []).forEach(deal => {
        if (etapasIgnorar.includes(deal.etapa)) return;
        const contactos   = vd.contactos || [];
        const contacto    = contactos.find(c => c.id === deal.contactoId);
        const nomContacto = contacto?.nombre || 'Sin contacto';
        const perfilV     = vendedor;

        if (deal.fechaLimite) {
          const limite        = new Date(deal.fechaLimite).getTime();
          const diasRestantes = Math.ceil((limite - ahora) / MS_DIA);
          const keyR          = `reunion_vd_${vendedor.id}_${deal.id}_${diasRestantes}d`;
          if ((diasRestantes === 1 || diasRestantes === 2) && !enviados.includes(keyR)) {
            acumularNotificacionSegmentada('reunion_proxima', {
              titulo:              deal.titulo,
              contacto:            nomContacto,
              fechaLimite:         fmtDate(deal.fechaLimite),
              diasRestantes,
              proximaAccion:       deal.proximaAccion || 'Sin definir',
              vendedor:            perfilV.nombre,
              _vendedorProfileId:  vendedor.id,
            }, perfilV);
            enviados.push(keyR);
          }
        }

        const ultimaAct  = deal.actualizadoEn || deal.creadoEn;
        const diasSinAct = Math.floor((ahora - ultimaAct) / MS_DIA);
        const keyS       = `sinact_vd_${vendedor.id}_${deal.id}_${Math.floor(diasSinAct / 3)}`;
        if (diasSinAct >= 3 && !enviados.includes(keyS)) {
          acumularNotificacionSegmentada('sin_actividad', {
            titulo:             deal.titulo,
            contacto:           nomContacto,
            diasSinActividad:   diasSinAct,
            ultimaAccion:       deal.proximaAccion || 'Sin registrar',
            vendedor:           perfilV.nombre,
            _vendedorProfileId: vendedor.id,
          }, perfilV);
          enviados.push(keyS);
        }
      });
    }
  }

 await sbSet(HOY_KEY, enviados);
}
/* ── VISTA: FORMULARIO DE PROSPECTO ────────────────────────── */
function prospectoForm() {
  document.getElementById('content').innerHTML = `
    <section id="view-prospecto-form"
             class="view"
             data-view="prospecto-form"
             aria-label="Formulario de prospecto">

      <div style="max-width:560px;margin:40px auto;padding:32px 16px">

        <div style="text-align:center;margin-bottom:32px">
          <div style="font-size:48px;margin-bottom:12px">🙋</div>
          <h2 style="font-size:22px;font-weight:700;color:var(--ink);margin:0 0 6px">
            ¡Hola! Cuéntanos sobre ti
          </h2>
          <p style="font-size:14px;color:var(--n-500);margin:0">
            Completa el formulario y un asesor NODE se pondrá en contacto contigo.
          </p>
        </div>

        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);padding:28px;display:flex;flex-direction:column;gap:18px">

          <div class="field">
            <label class="label" for="pf-nombre">Nombre completo <span class="req">*</span></label>
            <input type="text" id="pf-nombre" class="input" placeholder="Ej: Ana García" autocomplete="name">
          </div>

          <div class="field">
            <label class="label" for="pf-empresa">Empresa / Negocio</label>
            <input type="text" id="pf-empresa" class="input" placeholder="Ej: Fotografía AG">
          </div>

          <div class="form-row">
            <div class="field">
              <label class="label" for="pf-whatsapp">WhatsApp <span class="req">*</span></label>
              <input type="tel" id="pf-whatsapp" class="input" placeholder="5512345678" inputmode="tel">
            </div>
            <div class="field">
              <label class="label" for="pf-email">Correo electrónico</label>
              <input type="email" id="pf-email" class="input" placeholder="ana@empresa.com">
            </div>
          </div>

          <div class="field">
            <label class="label" for="pf-interes">¿En qué podemos ayudarte? <span class="req">*</span></label>
            <select id="pf-interes" class="input">
              <option value="">— Selecciona una opción —</option>
              <option value="sitio_web">Sitio web / Landing page</option>
              <option value="ecommerce">Tienda en línea</option>
              <option value="crm">CRM / Sistema de ventas</option>
              <option value="marketing">Marketing digital</option>
              <option value="app">Aplicación móvil</option>
              <option value="otro">Otro / No sé aún</option>
            </select>
          </div>

          <div class="field">
            <label class="label" for="pf-mensaje">Mensaje adicional</label>
            <textarea id="pf-mensaje" class="input textarea" rows="3"
              placeholder="Cuéntanos más sobre tu proyecto o necesidad..."></textarea>
          </div>

          <div id="pf-error" class="login-error hidden" role="alert" aria-live="polite">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            Por favor completa los campos obligatorios.
          </div>

          <button class="btn btn-primary" style="width:100%;justify-content:center"
            onclick="enviarProspecto()">
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <line x1="22" y1="2" x2="11" y2="13"/>
              <polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
            Enviar solicitud
          </button>

        </div>

        <p style="text-align:center;font-size:12px;color:var(--n-400);margin-top:20px">
          NODE Soluciones Tecnológicas · Tu información es confidencial
        </p>

      </div>
    </section>
  `;
}

/* ── Enviar formulario de prospecto ── */
function enviarProspecto() {
  const nombre   = document.getElementById('pf-nombre').value.trim();
  const whatsapp = document.getElementById('pf-whatsapp').value.trim();
  const interes  = document.getElementById('pf-interes').value;
  const errEl    = document.getElementById('pf-error');

  if (!nombre || !whatsapp || !interes) {
    errEl.classList.remove('hidden');
    return;
  }
  errEl.classList.add('hidden');

  const empresa = document.getElementById('pf-empresa').value.trim();
  const email   = document.getElementById('pf-email').value.trim();
  const mensaje = document.getElementById('pf-mensaje').value.trim();

  const nuevoContacto = {
    id:            'c_' + Date.now(),
    nombre,
    empresa,
    whatsapp,
    email,
    fuente:        'Formulario web',
    monto:         0,
    notas:         'Interés: ' + interes + (mensaje ? '\n' + mensaje : ''),
    creadoEn:      Date.now(),
    actualizadoEn: Date.now(),
  };
  S.contactos.push(nuevoContacto);
  saveState();

  // ── Notificar a admin y director de ventas que llegó un prospecto ──
  const _datosProspecto = {
    titulo:             'Nuevo prospecto registrado',
    contacto:           nombre,
    valor:              'Por determinar',
    proximaAccion:      'Contactar al prospecto registrado desde el formulario web',
    vendedor:           'Formulario web (auto-registro)',
    _vendedorProfileId: null,  // no viene de un vendedor individual
  };
  // Acumular en buzón admin y ventas
  ['admin','ventas'].forEach(dest => {
    const id    = 'n' + Date.now() + Math.random().toString(36).slice(2, 6);
    const notif = { id, tipo: 'prospecto_nuevo', datos: _datosProspecto, perfil: null, ts: Date.now(), enviada: false };
    const lista = getNotifDe(dest);
    lista.unshift(notif);
    if (lista.length > 100) lista.length = 100;
    saveNotifDe(dest, lista);
  });
  actualizarBadge();
  // Enviar WA a admin y directores
  notificarWhatsApp('deal_nuevo', _datosProspecto, 'admin');
  notificarWhatsApp('deal_nuevo', _datosProspecto, 'ventas');

  document.getElementById('content').innerHTML = `
    <div style="max-width:480px;margin:80px auto;text-align:center;padding:16px">
      <div style="font-size:56px;margin-bottom:16px">✅</div>
      <h2 style="font-size:22px;font-weight:700;color:var(--ink);margin:0 0 10px">
        ¡Solicitud enviada!
      </h2>
      <p style="font-size:15px;color:var(--n-500);margin:0 0 6px">
        Gracias, <strong>${nombre}</strong>. Hemos recibido tus datos.
      </p>
      <p style="font-size:14px;color:var(--n-400)">
        Un asesor NODE te contactará pronto por WhatsApp.
      </p>
    </div>
  `;
}
/* ═══════════════════════════════════════════════════════════════
   VISTA CONSOLIDADA — ADMIN / DIRECTOR DE VENTAS
   Permite ver el pipeline, contactos y actividades de CADA
   vendedor individualmente, más un resumen global de todos.
   ═══════════════════════════════════════════════════════════════ */

/* ── Estado del selector de vendedor (para admin/ventas) ── */
const VISTA_VENDEDOR = {
  vendedorId:  null,   // null = vista global de todos
  seccion:     'pipeline', // pipeline | contactos | actividades
};

/* ── Obtener todos los datos agregados de todos los vendedores ── */
async function getAllVendedoresData() {
  const vendedores = DEFAULT_PROFILES['venta'] || [];
  const results = await Promise.all(vendedores.map(async v => {
    const data = await getVendedorData(v.id);
    return {
      perfil:      v,
      contactos:   data.contactos   || [],
      deals:       data.deals       || [],
      actividades: data.actividades || [],
    };
  }));
  return results;
}

/* ── Obtener datos de un vendedor específico o del global ── */
async function getDataParaVista(vendedorId) {
  if (!vendedorId) {
    // Vista global: mezclar todos los vendedores
    const todos = await getAllVendedoresData();
    return {
      contactos:   todos.flatMap(v => v.contactos),
      deals:       todos.flatMap(v => v.deals),
      actividades: todos.flatMap(v => v.actividades),
    };
  }
  return await getVendedorData(vendedorId);
}

/* ── Render del selector de vendedor (tabs) ── */
async function renderVendedorSelectorHTML(seccionActiva) {
  const vendedores = DEFAULT_PROFILES['venta'] || [];
  const sel        = VISTA_VENDEDOR.vendedorId;

  const tabsWithCounts = await Promise.all(vendedores.map(async v => {
    const d = await getVendedorData(v.id);
    const activos = (d.deals || []).filter(x => !['ganado','perdido'].includes(x.etapa)).length;
    return { v, activos };
  }));

  const tabs = [
    { id: null, label: '📊 Todos', sub: 'Vista global' },
    ...vendedores.map(v => ({
      id:    v.id,
      label: `${v.emoji} ${v.nombre.split(' ')[0]}`,
      sub:   v.cargo,
    })),
  ];

  const tabsHTML = tabs.map((t, i) => {
    const activos = t.id ? (tabsWithCounts.find(x => x.v.id === t.id)?.activos || 0) : 0;
    return `
    <button
      class="vendedor-tab${sel === t.id ? ' active' : ''}"
      onclick="seleccionarVendedor(${t.id ? `'${t.id}'` : 'null'}, '${seccionActiva}')"
      title="${t.sub}"
    >
      ${t.label}
      ${t.id && activos > 0 ? `<span class="vendedor-tab-badge">${activos}</span>` : ''}
    </button>
  `}).join('');

  // Stats rápidas del vendedor seleccionado
  const data   = await getDataParaVista(sel);
  const activos = data.deals.filter(d => !['ganado','perdido'].includes(d.etapa));
  const ganados = data.deals.filter(d => d.etapa === 'ganado');
  const pipeline = activos.reduce((s,d) => s+(d.valor||0), 0);

  return `
    <div class="vendedor-selector-wrap">
      <div class="vendedor-selector-header">
        <div class="vendedor-selector-label">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
          Vista de vendedor
        </div>
        <div class="vendedor-selector-stats">
          <span class="vendedor-stat-chip">
            <strong style="color:var(--indigo)">${activos.length}</strong> activos
          </span>
          <span class="vendedor-stat-chip">
            <strong style="color:var(--teal)">${fmtMXN(pipeline)}</strong> pipeline
          </span>
          <span class="vendedor-stat-chip">
            <strong style="color:#10B981">${ganados.length}</strong> ganados
          </span>
        </div>
      </div>
      <div class="vendedor-tabs" role="tablist">
        ${tabsHTML}
      </div>
    </div>
  `;
}

function seleccionarVendedor(vendedorId, seccion) {
  VISTA_VENDEDOR.vendedorId = vendedorId;
  VISTA_VENDEDOR.seccion    = seccion || 'pipeline';
  // Re-renderizar la sección actual
  if      (seccion === 'pipeline')    pipelineAdmin();
  else if (seccion === 'contactos')   contactosAdmin();
  else if (seccion === 'actividades') actividadesAdmin();
}

/* ══════════════════════════════════════════════════════════════
   PIPELINE — ADMIN / DIRECTOR: con selector de vendedor
   ══════════════════════════════════════════════════════════════ */
function pipelineAdmin() {
  VISTA_VENDEDOR.seccion = 'pipeline';
  _pipelineAdminAsync();
}

async function _pipelineAdminAsync() {
  const data     = await getDataParaVista(VISTA_VENDEDOR.vendedorId);
  const deals    = data.deals;
  const contactos = data.contactos;

  // Helper local — buscar contacto dentro del dataset del vendedor
  const getC = (id) => contactos.find(c => c.id === id) || S.contactos.find(c => c.id === id);

  const nonClosed    = ['ganado','perdido'];
  const totalActive  = deals.filter(d => !nonClosed.includes(d.etapa)).reduce((s,d) => s+(d.valor||0), 0);
  const totalGanado  = deals.filter(d => d.etapa === 'ganado').reduce((s,d) => s+(d.valor||0), 0);
  const totalDeals   = deals.filter(d => !nonClosed.includes(d.etapa)).length;

  let html = await renderVendedorSelectorHTML('pipeline');

  html += `
  <div class="pipeline-header">
    <div class="pipeline-stats">
      <span class="pipe-stat">
        <span class="pipe-stat-label">Pipeline activo</span>
        <strong class="pipe-stat-val indigo">${fmtMXN(totalActive)}</strong>
      </span>
      <span class="pipe-stat-sep"></span>
      <span class="pipe-stat">
        <span class="pipe-stat-label">Deals activos</span>
        <strong class="pipe-stat-val teal">${totalDeals}</strong>
      </span>
      <span class="pipe-stat-sep"></span>
      <span class="pipe-stat">
        <span class="pipe-stat-label">Ganado total</span>
        <strong class="pipe-stat-val green">${fmtMXN(totalGanado)}</strong>
      </span>
    </div>
    <button class="btn btn-primary" onclick="openDealModal()">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      Nuevo deal
    </button>
  </div>
  <div class="pipeline-phases-container">`;

  FASES.forEach(fase => {
    const faseEtapas = ETAPAS.filter(e => e.fase === fase.id);
    const faseDeals  = deals.filter(d => faseEtapas.some(e => e.id === d.etapa));
    const faseValue  = faseDeals.reduce((s,d) => s+(d.valor||0), 0);

    html += `
    <div class="fase-group">
      <div class="fase-header" style="background:${fase.bg}">
        <div class="fase-header-left">
          <span class="fase-num" style="background:${fase.color}">F${fase.n}</span>
          <div>
            <div class="fase-title" style="color:${fase.tc}">${fase.label}</div>
            <div class="fase-desc"  style="color:${fase.tc}aa">${fase.desc}</div>
          </div>
        </div>
        <div class="fase-header-right">
          <span class="fase-badge" style="background:${fase.color}1a;color:${fase.tc}">${faseDeals.length} deal${faseDeals.length!==1?'s':''}</span>
          ${faseValue>0?`<span class="fase-badge" style="background:${fase.color}1a;color:${fase.tc}">${fmtMXN(faseValue)}</span>`:''}
        </div>
      </div>
      <div class="fase-cols">`;

    faseEtapas.forEach(e => {
      const etapaDeals = deals.filter(d => d.etapa === e.id);
      const colValue   = etapaDeals.reduce((s,d) => s+(d.valor||0), 0);
      html += `
        <div class="kanban-col">
          <div class="kanban-head" style="background:${e.bg};color:${e.tc}">
            <span>${e.emoji} ${e.label}</span>
            <span class="col-count">${etapaDeals.length}</span>
          </div>
          <div class="kanban-gate-chip" title="${e.gate}">
            <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
            ${e.gate}
          </div>
          ${colValue>0?`<div class="col-value-row" style="color:${e.tc}">${fmtMXN(colValue)}</div>`:''}
          <div class="kanban-cards">
            ${etapaDeals.map(d => dealCardAdminHTML(d, getC)).join('')}
          </div>
        </div>`;
    });
    html += `</div></div>`;
  });

  html += `</div>`;
  document.getElementById('content').innerHTML = html;
}

function dealCardAdminHTML(d, getContactoFn) {
  const c    = getContactoFn(d.contactoId);
  const over = isOverdue(d.fechaLimite) && !['ganado','perdido'].includes(d.etapa);
  const vendedor = getProfileById('venta', d.vendedorId);
  const vendedorId = d.vendedorId || null;

  return `<div class="deal-card"
    data-id="${d.id}"
    data-vendedor-id="${vendedorId || ''}"
    onclick="openDealDrawerAdmin('${d.id}','${vendedorId || ''}')"
    ondblclick="event.stopPropagation()"
    title="Clic: ver actividades del prospecto"
    style="cursor:pointer">
    ${vendedor ? `<div class="deal-vendedor-chip">
      <span style="font-size:13px">${vendedor.emoji}</span>
      <span>${escapeHTML(vendedor.nombre)}</span>
    </div>` : ''}
    <div class="deal-title">${escapeHTML(d.titulo)}</div>
    ${c ? `<div class="deal-contact-chip">
      <div class="mini-avatar">${initials(c.nombre)}</div>${escapeHTML(c.nombre)}
    </div>` : ''}
    <div class="deal-value">${fmtMXN(d.valor)}</div>
    <div class="deal-footer">
      <div class="deal-next">${d.proximaAccion ? '→ '+escapeHTML(d.proximaAccion) : ''}</div>
      ${d.fechaLimite ? `<div class="deal-date${over?' overdue':''}">${over?'⚠️ ':''}${fmtDate(d.fechaLimite)}</div>` : ''}
    </div>
  </div>`;
}

/* ── Drawer admin: busca datos en el store del vendedor correcto ── */
function openDealDrawerAdmin(dealId, vendedorId) {
  // Obtener datos del vendedor correspondiente o del global
  const data = vendedorId ? getVendedorData(vendedorId) : getDataParaVista(null);
  const d    = data.deals.find(x => x.id === dealId);
  if (!d) return;

  const allContactos = [...data.contactos, ...S.contactos];
  const c = allContactos.find(x => x.id === d.contactoId);
  const e = getEtapa(d.etapa);

  // Header
  document.getElementById('drawer-deal-title').textContent = d.titulo;
  document.getElementById('drawer-deal-meta').innerHTML = `
    <span class="badge" style="background:${e.bg};color:${e.tc};font-size:10px">${e.emoji} ${e.label}</span>
    ${c ? `<span style="font-size:11px;color:var(--n-500)">· ${escapeHTML(c.nombre)}</span>` : ''}
    ${vendedorId ? (() => {
      const vp = getProfileById('venta', vendedorId);
      return vp ? `<span style="font-size:11px;color:var(--n-500)">· ${vp.emoji} ${vp.nombre}</span>` : '';
    })() : ''}`;

  // Stats
  const over = isOverdue(d.fechaLimite) && !['ganado','perdido'].includes(d.etapa);
  document.getElementById('drawer-deal-stats').innerHTML = `
    <div class="drawer-stat">
      <div class="drawer-stat-val">${fmtMXN(d.valor)}</div>
      <div class="drawer-stat-lbl">Valor</div>
    </div>
    <div class="drawer-stat">
      <div class="drawer-stat-val" style="${over ? 'color:var(--error)' : ''}">${d.fechaLimite ? fmtDate(d.fechaLimite) : '—'}</div>
      <div class="drawer-stat-lbl">Fecha límite</div>
    </div>
    <div class="drawer-stat">
      <div class="drawer-stat-val" style="font-size:12px;color:var(--n-600)">${d.proximaAccion ? escapeHTML(d.proximaAccion.slice(0,22))+(d.proximaAccion.length>22?'…':'') : '—'}</div>
      <div class="drawer-stat-lbl">Próxima acción</div>
    </div>`;

  // Actividades del contacto dentro del store del vendedor
  const acts = c ? data.actividades.filter(a => a.contactoId === c.id).sort((x,y) => y.creadoEn - x.creadoEn) : [];
  document.getElementById('drawer-act-count').textContent = acts.length;

  document.getElementById('drawer-act-list').innerHTML = acts.length === 0
    ? `<div class="drawer-empty">
        <div class="drawer-empty-icon">📋</div>
        Sin actividades para este contacto.
       </div>`
    : acts.map(a => `
        <div class="drawer-act-item">
          <div class="drawer-act-icon" style="background:${ACT_BG[a.tipo]||'#f8f9fb'}">${ACT_ICONS[a.tipo]||'📌'}</div>
          <div class="drawer-act-body">
            <div class="drawer-act-tipo">${ACT_LABELS[a.tipo]||a.tipo}</div>
            <div class="drawer-act-desc">${escapeHTML(a.descripcion)}</div>
            <div class="drawer-act-time">${timeAgo(a.creadoEn)}</div>
          </div>
        </div>`).join('');

  // Guardar referencia — modo lectura para admin
  const drawer = document.getElementById('deal-drawer');
  drawer.dataset.dealId      = dealId;
  drawer.dataset.contactoId  = d.contactoId || '';
  drawer.dataset.adminMode   = '1';

  // Footer en modo lectura (sin editar)
  document.getElementById('drawer-btn-actividad').style.display = 'none';
  document.getElementById('drawer-btn-deal').textContent = 'Cerrar';
  document.getElementById('drawer-btn-deal').onclick = closeDealDrawer;

  drawer.classList.add('open');
  document.getElementById('drawer-backdrop').classList.add('open');
}

/* ══════════════════════════════════════════════════════════════
   CONTACTOS — ADMIN / DIRECTOR: con selector de vendedor
   ══════════════════════════════════════════════════════════════ */
function contactosAdmin() {
  VISTA_VENDEDOR.seccion = 'contactos';
  _contactosAdminAsync();
}

async function _contactosAdminAsync() {
  const data     = await getDataParaVista(VISTA_VENDEDOR.vendedorId);
  const list     = [...data.contactos].sort((a,b) => b.actualizadoEn - a.actualizadoEn);
  const deals    = data.deals;
  const getDeals = (cid) => deals.filter(d => d.contactoId === cid).sort((x,y) => y.actualizadoEn - x.actualizadoEn);

  let html = await renderVendedorSelectorHTML('contactos');

  html += `
  <div class="view-header">
    <span class="badge badge-neutral">${list.length} contactos</span>
    <div class="view-filters">
      <button class="btn btn-ghost btn-sm" onclick="exportCSVAdmin('contactos')" title="Exportar CSV">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        CSV
      </button>
      <button class="btn btn-primary" onclick="openContactoModal()">+ Contacto</button>
    </div>
  </div>`;

  if (list.length === 0) {
    html += `<div class="empty"><div class="empty-icon">👥</div><p class="empty-title">Sin contactos</p><p class="empty-desc">Este vendedor aún no tiene contactos registrados.</p></div>`;
  } else {
    html += `<div class="contacts-table-wrap">
      <table class="contacts-table">
        <thead><tr>
          <th>Contacto</th><th>Empresa</th><th>Fuente</th>
          <th>Monto est.</th><th>Etapa actual</th><th>Actualización</th>
        </tr></thead>
        <tbody>`;

    list.forEach(c => {
      const cDeals   = getDeals(c.id);
      const dealAct  = cDeals.find(d => d.etapa !== 'perdido') || cDeals[0];
      const etapa    = dealAct ? getEtapa(dealAct.etapa) : null;

      // Vendedor asignado
      const vendedorPerfil = VISTA_VENDEDOR.vendedorId
        ? getProfileById('venta', VISTA_VENDEDOR.vendedorId)
        : (dealAct?.vendedorId ? getProfileById('venta', dealAct.vendedorId) : null);

      html += `<tr>
        <td><div class="contact-row-name">
          <div class="contact-avatar" style="background:${etapa?.color||'var(--indigo)'}">
            ${initials(c.nombre)}
          </div>
          <div>
            <div class="contact-name">${escapeHTML(c.nombre)}</div>
            <div class="contact-email">${escapeHTML(c.email||'—')}</div>
          </div>
        </div></td>
        <td style="font-size:13px;color:var(--n-600)">${escapeHTML(c.empresa||'—')}</td>
        <td>
          <span class="badge badge-indigo">${escapeHTML(c.fuente||'—')}</span>
          ${vendedorPerfil ? `<span class="badge" style="background:var(--n-100);color:var(--n-700);margin-left:4px;font-size:10px">${vendedorPerfil.emoji} ${vendedorPerfil.nombre.split(' ')[0]}</span>` : ''}
        </td>
        <td class="money" style="font-size:13px">${fmtMXN(c.monto)}</td>
        <td>${etapa ? `<span class="badge" style="background:${etapa.bg};color:${etapa.tc};border:1px solid ${etapa.color}33">${etapa.emoji} ${etapa.label}</span>` : '<span class="badge badge-neutral">Sin deal</span>'}</td>
        <td style="font-size:12px;color:var(--n-500)">${timeAgo(c.actualizadoEn)}</td>
      </tr>`;
    });

    html += `</tbody></table></div>`;
  }

  document.getElementById('content').innerHTML = html;
}

/* ══════════════════════════════════════════════════════════════
   ACTIVIDADES — ADMIN / DIRECTOR: con selector de vendedor
   ══════════════════════════════════════════════════════════════ */
function actividadesAdmin() {
  VISTA_VENDEDOR.seccion = 'actividades';
  _actividadesAdminAsync();
}

async function _actividadesAdminAsync() {
  const data  = await getDataParaVista(VISTA_VENDEDOR.vendedorId);
  const list  = [...data.actividades].sort((a,b) => b.creadoEn - a.creadoEn);
  const allC  = [...data.contactos, ...S.contactos];
  const getC  = (id) => allC.find(c => c.id === id);

  const pendientes = list.filter(a => !a.realizado);
  const realizadas = list.filter(a =>  a.realizado);

  let html = await renderVendedorSelectorHTML('actividades');

  html += `
  <div class="view-header" style="margin-bottom:12px">
    <span class="badge badge-neutral">${list.length} registros</span>
    <div style="display:flex;gap:8px">
      <button class="btn btn-ghost btn-sm" onclick="exportCSVAdmin('actividades')">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        CSV
      </button>
      <button class="btn btn-primary" onclick="openActividadModal()">+ Actividad</button>
    </div>
  </div>`;

  if (pendientes.length === 0 && realizadas.length === 0) {
    html += `<div class="empty"><div class="empty-icon">📋</div><p class="empty-title">Sin actividades</p><p class="empty-desc">Este vendedor aún no tiene actividades registradas.</p></div>`;
  } else {
    // Pendientes
    if (pendientes.length > 0) {
      html += `<div class="activity-feed">`;
      pendientes.forEach(a => {
        const c = getC(a.contactoId);
        const vId = VISTA_VENDEDOR.vendedorId || '';
        html += `<div class="activity-item">
          <div class="act-icon" style="background:${ACT_BG[a.tipo]||'#f8f9fb'}">${ACT_ICONS[a.tipo]||'📌'}</div>
          <div class="act-body">
            <div class="act-meta">
              <span class="act-contact">${escapeHTML(c?.nombre||'Contacto eliminado')}</span>
              <span class="act-type">${ACT_LABELS[a.tipo]||a.tipo}</span>
              <span class="act-time">${timeAgo(a.creadoEn)}</span>
            </div>
            <p class="act-desc">${escapeHTML(a.descripcion)}</p>
          </div>
          <button class="icon-btn realizado" onclick="marcarActividadRealizadaAdmin('${a.id}','${vId}')" title="Marcar como realizado">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          </button>
        </div>`;
      });
      html += `</div>`;
    }

    // Realizadas
    if (realizadas.length > 0) {
      html += `
      <div id="section-acts-realizadas-admin" class="realizados-section" style="margin-top:24px">
        <div class="realizados-header">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          Realizados
          <span class="badge badge-neutral" style="font-size:10px">${realizadas.length}</span>
        </div>
        <div class="activity-feed">`;
      realizadas.forEach(a => {
        const c = getC(a.contactoId);
        html += `<div class="activity-item act-realizada">
          <div class="act-icon" style="background:${ACT_BG[a.tipo]||'#f8f9fb'}">${ACT_ICONS[a.tipo]||'📌'}</div>
          <div class="act-body">
            <div class="act-meta">
              <span class="act-contact">${escapeHTML(c?.nombre||'Contacto eliminado')}</span>
              <span class="act-type">${ACT_LABELS[a.tipo]||a.tipo}</span>
              <span class="act-time">${timeAgo(a.creadoEn)}</span>
              <span class="act-realizado-badge">✅ Realizado</span>
            </div>
            <p class="act-desc">${escapeHTML(a.descripcion)}</p>
          </div>
        </div>`;
      });
      html += `</div></div>`;
    }
  }

  document.getElementById('content').innerHTML = html;
}

/* ── Marcar actividad realizada desde vista admin ── */
async function marcarActividadRealizadaAdmin(actId, vendedorId) {
  let encontrado = false;
  if (vendedorId) {
    const vd = await getVendedorData(vendedorId);
    const a  = (vd.actividades || []).find(x => x.id === actId);
    if (a) { a.realizado = true; a.realizadoEn = Date.now(); await saveVendedorData(vendedorId, vd); encontrado = true; }
  }
  if (!encontrado) {
    const vendedores = DEFAULT_PROFILES['venta'] || [];
    for (const v of vendedores) {
      const vd = await getVendedorData(v.id);
      const a  = (vd.actividades || []).find(x => x.id === actId);
      if (a) { a.realizado = true; a.realizadoEn = Date.now(); await saveVendedorData(v.id, vd); encontrado = true; break; }
    }
  }
  if (!encontrado) {
    const a = S.actividades.find(x => x.id === actId);
    if (a) { a.realizado = true; a.realizadoEn = Date.now(); saveState(); }
  }
  actividadesAdmin();
  setTimeout(() => {
    const sec = document.getElementById('section-acts-realizadas-admin');
    if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 150);
  toast('✅ Realizado', '', 'success');
}

/* ── Exportar CSV de vista admin ── */
async function exportCSVAdmin(tipo) {
  const data = await getDataParaVista(VISTA_VENDEDOR.vendedorId);
  const allC = [...data.contactos, ...S.contactos];
  const getC = (id) => allC.find(c => c.id === id);
  let rows = [], filename = '';

  if (tipo === 'contactos') {
    filename = 'node-admin-contactos.csv';
    rows = [['Nombre','Empresa','WhatsApp','Email','Fuente','Monto MXN','Creado']];
    data.contactos.forEach(c => rows.push([c.nombre,c.empresa,c.whatsapp,c.email,c.fuente,c.monto,fmtDate(c.creadoEn)]));
  } else if (tipo === 'actividades') {
    filename = 'node-admin-actividades.csv';
    rows = [['Tipo','Contacto','Descripción','Fecha']];
    data.actividades.forEach(a => rows.push([ACT_LABELS[a.tipo]||a.tipo,getC(a.contactoId)?.nombre||'',a.descripcion,fmtDate(a.creadoEn)]));
  }

  const csv  = rows.map(r => r.map(v => `"${String(v||'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob(['\uFEFF'+csv], { type:'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href:url, download:filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('CSV exportado', filename, 'success');
}

/* ══════════════════════════════════════════════════════════════
   DASHBOARD ADMIN — Resumen de todos los vendedores
   ══════════════════════════════════════════════════════════════ */
function dashboardAdmin() {
  _dashboardAdminAsync();
}

async function _dashboardAdminAsync() {
  const todosData = await getAllVendedoresData();

  // Métricas globales
  const allDeals  = todosData.flatMap(v => v.deals);
  const allActs   = todosData.flatMap(v => v.actividades);
  const activos   = allDeals.filter(d => !['ganado','perdido'].includes(d.etapa));
  const pipeTotal = activos.reduce((s,d) => s+(d.valor||0), 0);
  const ganados   = allDeals.filter(d => d.etapa === 'ganado').length;
  const semanaAgo = Date.now() - 7 * 86_400_000;
  const actsWeek  = allActs.filter(a => a.creadoEn >= semanaAgo).length;

  // Cargar los datos globales en S.deals / S.actividades para que buildCharts() los use
  // (solo lectura — no se persiste, se reemplaza al cambiar de vista)
  S.deals       = allDeals;
  S.actividades = allActs;
  S.contactos   = todosData.flatMap(v => v.contactos);

  // Actividades recientes y top deals globales para los paneles inferiores
  const recentActs = [...allActs].sort((a,b) => b.creadoEn - a.creadoEn).slice(0, 5);
  const topDeals   = [...activos].sort((a,b) => b.valor - a.valor).slice(0, 5);

  let html = `
  <div class="stats-grid">
    ${mkStatCard('👥','Vendedores activos', todosData.length, '#EEF2FF','#4338CA')}
    ${mkStatCard('💰','Pipeline total', fmtMXN(pipeTotal), '#F0FDFB','#0D9488')}
    ${mkStatCard('✅','Deals ganados total', ganados, '#D1FAE5','#10B981')}
    ${mkStatCard('📋','Actividades / semana', actsWeek, '#FEF3C7','#F59E0B')}
  </div>

  <div class="dashboard-cols">
    <div class="chart-card">
      <div class="chart-title">Pipeline por etapa</div>
      <div class="chart-sub">Valor de deals activos por etapa · todos los vendedores (MXN)</div>
      <div class="chart-canvas"><canvas id="chart-bar"></canvas></div>
    </div>
    <div class="chart-card">
      <div class="chart-title">Distribución de deals</div>
      <div class="chart-sub">Cantidad de deals por estado · todos los vendedores</div>
      <div class="chart-canvas"><canvas id="chart-donut"></canvas></div>
    </div>
  </div>

  <div class="dashboard-bottom">
    <div class="chart-card">
      <div class="panel-title">Actividades recientes</div>
      ${recentActs.length
        ? recentActs.map(a => miniActHTML(a)).join('')
        : emptyState('📋','Sin actividades','Los vendedores aún no tienen actividades.')}
    </div>
    <div class="chart-card">
      <div class="panel-title">Top deals en pipeline</div>
      ${topDeals.length
        ? topDeals.map(d => miniDealHTML(d)).join('')
        : emptyState('⭐','Sin deals activos','Agrega deals al pipeline.')}
    </div>
  </div>

  <div class="admin-vendedores-grid">`;

  todosData.forEach(({ perfil, deals, contactos, actividades }) => {
    const act    = deals.filter(d => !['ganado','perdido'].includes(d.etapa));
    const pipe   = act.reduce((s,d) => s+(d.valor||0), 0);
    const won    = deals.filter(d => d.etapa === 'ganado').length;
    const actsV  = actividades.filter(a => a.creadoEn >= semanaAgo).length;
    const vencidos = act.filter(d => isOverdue(d.fechaLimite)).length;

    // Top 3 deals activos por valor
    const topDeals = [...act].sort((a,b) => b.valor - a.valor).slice(0,3);

    html += `
    <div class="vendedor-card-admin">
      <div class="vendedor-card-header">
        <div class="vendedor-card-avatar">${perfil.emoji}</div>
        <div class="vendedor-card-info">
          <div class="vendedor-card-name">${escapeHTML(perfil.nombre)}</div>
          <div class="vendedor-card-cargo">${escapeHTML(perfil.cargo)}</div>
        </div>
        <div class="vendedor-card-actions">
          <button class="btn btn-secondary btn-sm"
            onclick="seleccionarVendedor('${perfil.id}','pipeline');navigate('pipeline')">
            Pipeline
          </button>
          <button class="btn btn-ghost btn-sm"
            onclick="seleccionarVendedor('${perfil.id}','contactos');navigate('contactos')">
            Contactos
          </button>
        </div>
      </div>

      <div class="vendedor-card-stats">
        <div class="vc-stat">
          <div class="vc-stat-val" style="color:var(--indigo)">${act.length}</div>
          <div class="vc-stat-lbl">Activos</div>
        </div>
        <div class="vc-stat">
          <div class="vc-stat-val" style="color:var(--teal)">${fmtMXN(pipe)}</div>
          <div class="vc-stat-lbl">Pipeline</div>
        </div>
        <div class="vc-stat">
          <div class="vc-stat-val" style="color:#10B981">${won}</div>
          <div class="vc-stat-lbl">Ganados</div>
        </div>
        <div class="vc-stat">
          <div class="vc-stat-val" style="color:var(--n-600)">${contactos.length}</div>
          <div class="vc-stat-lbl">Contactos</div>
        </div>
        <div class="vc-stat">
          <div class="vc-stat-val" style="color:var(--n-600)">${actsV}</div>
          <div class="vc-stat-lbl">Acts/sem</div>
        </div>
        ${vencidos > 0 ? `<div class="vc-stat">
          <div class="vc-stat-val" style="color:var(--error)">${vencidos}</div>
          <div class="vc-stat-lbl">Vencidos</div>
        </div>` : ''}
      </div>

      ${topDeals.length > 0 ? `
      <div class="vendedor-card-deals">
        <div class="vc-deals-title">Top deals activos</div>
        ${topDeals.map(d => {
          const e = getEtapa(d.etapa);
          const c = contactos.find(x => x.id === d.contactoId);
          return `<div class="vc-deal-row">
            <div class="vc-deal-info">
              <div class="vc-deal-titulo">${escapeHTML(d.titulo)}</div>
              <div class="vc-deal-contacto">${escapeHTML(c?.nombre||'—')}</div>
            </div>
            <div class="vc-deal-right">
              <div class="money" style="font-size:12px;color:var(--indigo)">${fmtMXN(d.valor)}</div>
              <span class="badge" style="background:${e.bg};color:${e.tc};font-size:10px">${e.emoji} ${e.label}</span>
            </div>
          </div>`;
        }).join('')}
      </div>` : `<div style="padding:12px 16px;font-size:12px;color:var(--n-400);text-align:center">Sin deals activos</div>`}
    </div>`;
  });

  html += `</div>`;
  document.getElementById('content').innerHTML = html;

  // Inicializar gráficas con el dataset global cargado en S
  CHART_STATE.expandedFase = null;
  requestAnimationFrame(buildCharts);
}
