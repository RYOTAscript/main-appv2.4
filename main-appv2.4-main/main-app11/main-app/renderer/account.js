// Account / License management for the Settings modal (Account section).
// Talks to the main process via window.electronAPI.license* (see preload.js).

// Hold the full key in memory so the on-screen value can stay masked while Copy
// still copies the real thing.
let __accountKeyFull = '';

function maskLicenseKey(key) {
    if (!key) return '';
    const parts = key.split('-');
    if (parts.length < 3) return key;
    return parts.map((p, i) => (i === 0 || i === parts.length - 1 ? p : '••••')).join('-');
}

async function loadAccountInfo() {
    if (!window.electronAPI?.licenseGetAccount) return;
    const section = document.getElementById('account-section');
    let acct = null;
    try {
        acct = await window.electronAPI.licenseGetAccount();
    } catch (e) {
        return;
    }
    if (!acct || !acct.key) {
        // No stored license (shouldn't happen while unlocked) — hide the card.
        if (section) section.style.display = 'none';
        return;
    }
    if (section) section.style.display = '';

    __accountKeyFull = acct.key;
    const provider = acct.provider === 'google' ? 'Google' : 'License key';
    const nameEl = document.getElementById('account-name');
    const mailEl = document.getElementById('account-email');
    const initEl = document.getElementById('account-initial');
    const keyEl = document.getElementById('account-key');
    const metaEl = document.getElementById('account-meta');

    if (nameEl) nameEl.textContent = acct.name || (acct.email ? acct.email : 'Licensed');
    if (mailEl) mailEl.textContent = acct.email || (acct.provider === 'google' ? 'Google account' : 'Unlocked with a license key');
    if (initEl) initEl.textContent = (acct.email || acct.name || 'M').charAt(0).toUpperCase();
    if (keyEl) keyEl.textContent = maskLicenseKey(acct.key);

    const since = acct.issuedAt
        ? new Date(acct.issuedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
        : null;
    const checked = acct.lastVerified ? new Date(acct.lastVerified).toLocaleString() : null;
    if (metaEl) {
        metaEl.textContent = `via ${provider}` + (since ? ` · since ${since}` : '') + (checked ? ` · last checked ${checked}` : '');
    }

    const status = document.getElementById('account-recheck-status');
    if (status) status.textContent = '';
}

async function copyLicenseKey() {
    try {
        await navigator.clipboard.writeText(__accountKeyFull || '');
        if (typeof showToast === 'function') showToast('License key copied');
    } catch (e) {
        /* clipboard blocked — ignore */
    }
}

function openAccountWebsite() {
    window.electronAPI?.licenseOpenAccount?.();
}

function openSupport() {
    window.electronAPI?.licenseOpenSupport?.();
}

async function recheckLicense() {
    const status = document.getElementById('account-recheck-status');
    const btn = document.getElementById('account-recheck-btn');
    if (status) { status.style.color = '#737373'; status.textContent = 'Checking…'; }
    if (btn) btn.disabled = true;
    try {
        const r = await window.electronAPI.licenseRecheck();
        if (r && r.unlocked) {
            if (status) {
                status.style.color = '#34d399';
                status.textContent = r.offline
                    ? 'Using your cached license (offline).'
                    : 'License is valid. ✓';
            }
            loadAccountInfo();
        } else {
            if (status) {
                status.style.color = '#f87171';
                status.textContent = 'This license is no longer valid.';
            }
        }
    } catch (e) {
        if (status) { status.style.color = '#f87171'; status.textContent = 'Could not check right now.'; }
    }
    if (btn) btn.disabled = false;
}

// Show the on-brand glass confirmation instead of a native confirm() box.
function logoutAccount() {
    const modal = document.getElementById('logout-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
}

function closeLogoutModal() {
    const modal = document.getElementById('logout-modal');
    if (modal) modal.classList.add('hidden');
}

async function confirmLogout() {
    closeLogoutModal();
    if (typeof showToast === 'function') showToast('Logging out…');
    try {
        await window.electronAPI.licenseLogout();
    } catch (e) {
        /* the app relaunches on success, so we normally never get here */
    }
}
