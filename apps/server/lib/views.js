/**
 * Server-side entry point for the shared templates.
 *
 * The implementation lives in `client/shared/render.js` so that the browser,
 * the desktop shell and the Node server all render from one source. This file
 * stays as a stable re-export so existing server imports keep working.
 */
export {
  escapeHtml,
  renderArchiveDeleteAction,
  renderArchiveRow,
  renderArchiveList,
  renderPagination,
  renderArchiveEmptyState,
  renderArchivePayload
} from '../../client/shared/render.js';
