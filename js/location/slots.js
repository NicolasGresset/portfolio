// slots.js - Arrival slot picker: today's 15 min ranges, from the one before the current range;
// default to the first one starting in 30 min or more. A list button showing about 10 ranges at a
// time (see .slot-options), with native-select keyboard behavior

// slot: the button showing the picked range, slotOptions: its list of ranges;
// returns a function giving the picked range's start ("HH:MM")
export function slotPicker(slot, slotOptions) {
    const hhmm = minutes => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    const slotLabel = minutes => `${hhmm(minutes)} – ${hhmm(minutes + 15)}`;
    const slots = []; // range starts, in minutes since midnight
    let slotIndex = 0;

    // Scroll the list itself (scrollIntoView would also scroll the page)
    function revealSlot(center) {
        const li = slotOptions.children[slotIndex];
        if (center) {
            slotOptions.scrollTop = li.offsetTop - (slotOptions.clientHeight - li.offsetHeight) / 2;
        } else if (li.offsetTop < slotOptions.scrollTop) {
            slotOptions.scrollTop = li.offsetTop;
        } else if (li.offsetTop + li.offsetHeight > slotOptions.scrollTop + slotOptions.clientHeight) {
            slotOptions.scrollTop = li.offsetTop + li.offsetHeight - slotOptions.clientHeight;
        }
    }

    function selectSlot(index) {
        slotIndex = Math.max(0, Math.min(slots.length - 1, index));
        slot.textContent = slotLabel(slots[slotIndex]);
        [...slotOptions.children].forEach((li, i) => li.setAttribute('aria-selected', i === slotIndex ? 'true' : 'false'));
        slotOptions.setAttribute('aria-activedescendant', `slot-option-${slotIndex}`);
        if (!slotOptions.hidden) revealSlot(false);
    }

    function openSlots() {
        slotOptions.hidden = false;
        slot.setAttribute('aria-expanded', 'true');
        revealSlot(true);
        slotOptions.focus();
    }

    function closeSlots(refocus) {
        slotOptions.hidden = true;
        slot.setAttribute('aria-expanded', 'false');
        if (refocus) slot.focus();
    }

    (function fillSlots() {
        const now = new Date();
        const minutes = now.getHours() * 60 + now.getMinutes();
        for (let m = Math.max(0, Math.floor(minutes / 15) * 15 - 15); m < 24 * 60; m += 15) slots.push(m);
        slotOptions.innerHTML = slots.map((m, i) =>
            `<li role="option" id="slot-option-${i}" data-index="${i}" aria-selected="false">${slotLabel(m)}</li>`).join('');
        const soon = slots.findIndex(m => m >= minutes + 30);
        selectSlot(soon >= 0 ? soon : slots.length - 1);
    })();

    slot.addEventListener('click', () => (slotOptions.hidden ? openSlots() : closeSlots(true)));
    // Closed: arrows change the range directly, as on a native select
    slot.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); openSlots(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); selectSlot(slotIndex + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); selectSlot(slotIndex - 1); }
    });
    slotOptions.addEventListener('keydown', e => {
        const moves = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 };
        if (e.key in moves) { e.preventDefault(); selectSlot(slotIndex + moves[e.key]); }
        else if (e.key === 'Home') { e.preventDefault(); selectSlot(0); }
        else if (e.key === 'End') { e.preventDefault(); selectSlot(slots.length - 1); }
        else if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') { e.preventDefault(); closeSlots(true); }
        else if (e.key === 'Tab') closeSlots(false);
    });
    slotOptions.addEventListener('click', e => {
        const li = e.target.closest('li[data-index]');
        if (!li) return;
        selectSlot(Number(li.dataset.index));
        closeSlots(true);
    });
    document.addEventListener('click', e => {
        if (!slotOptions.hidden && !e.target.closest('.slot-field')) closeSlots(false);
    });

    return () => hhmm(slots[slotIndex]);
}
