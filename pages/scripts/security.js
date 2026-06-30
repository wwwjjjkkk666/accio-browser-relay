/**
 * Shared security helpers for extension UI pages.
 */
(function () {
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/>/g, '&gt;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  window.AccioSecurity = {
    escapeHtml: escapeHtml,
  };
})();
