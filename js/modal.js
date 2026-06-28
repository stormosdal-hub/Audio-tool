// modal.js — a lightweight pop-up window used on mobile.
//
// Instead of cloning markup, it MOVES an existing DOM node into the overlay and
// moves it back on close. Reparenting preserves every event listener already
// wired elsewhere (the lane settings sliders in main.js, the whole Highlight
// Scale in scale.js), so the pop-up is fully live with zero re-wiring. One
// modal is open at a time. Close via the ✕, the backdrop, or Escape.

let _open = null; // { node, anchor, onClose }

const modalEl = () => document.getElementById("appModal");

export function isModalOpen() {
  return !!_open;
}

// Move `node` into the modal and show it. `onClose` (optional) runs after the
// node is returned home — use it to reset the trigger button / re-hide state.
export function openModal(node, title, onClose) {
  const modal = modalEl();
  if (!node || !modal) return;
  closeModal(); // never stack two

  modal.querySelector(".modal-title").textContent = title || "";

  // Leave a marker where the node lived so it returns to the exact same spot.
  const anchor = document.createComment("modal-home");
  node.parentNode.insertBefore(anchor, node);
  modal.querySelector(".modal-body").appendChild(node);
  node.classList.add("in-modal");

  modal.classList.remove("hidden");
  document.body.classList.add("modal-lock");
  _open = { node, anchor, onClose };
}

export function closeModal() {
  if (!_open) return;
  const { node, anchor, onClose } = _open;
  _open = null; // clear first so a re-entrant call is a no-op

  node.classList.remove("in-modal");
  // anchor.parentNode is null only if the node's home was removed while open —
  // then just leave it detached rather than throwing.
  if (anchor.parentNode) anchor.parentNode.insertBefore(node, anchor);
  anchor.remove();

  modalEl()?.classList.add("hidden");
  document.body.classList.remove("modal-lock");
  if (onClose) { try { onClose(); } catch (e) {} }
}

// Wire the shared close affordances once, at startup.
export function initModal() {
  const modal = modalEl();
  if (!modal) return;
  modal.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && _open) closeModal();
  });
}
