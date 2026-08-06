import { create } from 'zustand';

type TextInput = HTMLInputElement | HTMLTextAreaElement;

interface FieldTargetState {
  /** The input the user most recently typed in, inside the config panel. */
  element: TextInput | null;
  label: string | null;
  setTarget: (element: TextInput | null, label?: string) => void;
  insert: (text: string) => boolean;
}

/**
 * React owns the value of every config input, so assigning `element.value`
 * directly is ignored on the next render. Going through the prototype's native
 * setter and then dispatching a bubbling `input` event is the supported way to
 * make React notice a programmatic change.
 */
function setReactValue(element: TextInput, value: string): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;

  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (setter) setter.call(element, value);
  else element.value = value;

  element.dispatchEvent(new Event('input', { bubbles: true }));
}

export const useFieldTarget = create<FieldTargetState>((set, get) => ({
  element: null,
  label: null,

  setTarget(element, label) {
    set({ element, label: label ?? null });
  },

  /**
   * Inserts at the caret, replacing any selection. Returns false when there is
   * nowhere to insert, so the caller can fall back to copying instead.
   */
  insert(text) {
    const element = get().element;
    if (!element || !element.isConnected) return false;

    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? start;
    const before = element.value.slice(0, start);
    const after = element.value.slice(end);

    // Avoid gluing an expression onto the previous word.
    const needsSpace = before.length > 0 && !/[\s({[,:=]$/.test(before);
    const insertion = `${needsSpace ? ' ' : ''}${text}`;

    setReactValue(element, `${before}${insertion}${after}`);

    const caret = start + insertion.length;
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(caret, caret);
    });

    return true;
  },
}));
