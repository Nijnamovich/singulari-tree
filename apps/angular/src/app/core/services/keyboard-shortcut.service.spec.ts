import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KeyboardShortcutService,
  isEditableTarget,
  isInteractiveTarget,
  normalizeKey,
} from './keyboard-shortcut.service';

describe('normalizeKey', () => {
  it('maps space and lowercases every other key', () => {
    expect(normalizeKey(' ')).toBe('space');
    expect(normalizeKey('ArrowDown')).toBe('arrowdown');
    expect(normalizeKey('A')).toBe('a');
  });
});

describe('isEditableTarget', () => {
  it('treats input, textarea and select as editable', () => {
    for (const tag of ['input', 'textarea', 'select']) {
      expect(isEditableTarget(document.createElement(tag))).toBe(true);
    }
  });

  it('does not treat native buttons or anchors as editable', () => {
    expect(isEditableTarget(document.createElement('button'))).toBe(false);
    expect(isEditableTarget(document.createElement('a'))).toBe(false);
  });

  it('detects a contenteditable element and its descendants', () => {
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const child = document.createElement('span');
    editable.appendChild(child);

    expect(isEditableTarget(editable)).toBe(true);
    expect(isEditableTarget(child)).toBe(true);
  });

  it('treats plaintext-only contenteditable as editable', () => {
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'plaintext-only');

    expect(isEditableTarget(editable)).toBe(true);
  });

  it('does not treat contenteditable="false" as editable', () => {
    const notEditable = document.createElement('div');
    notEditable.setAttribute('contenteditable', 'false');
    const child = document.createElement('span');
    notEditable.appendChild(child);

    expect(isEditableTarget(notEditable)).toBe(false);
    expect(isEditableTarget(child)).toBe(false);
  });

  it('returns false for null and non-element targets', () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(document as unknown as EventTarget)).toBe(false);
  });
});

describe('isInteractiveTarget', () => {
  it('matches native controls, links and role=button', () => {
    const button = document.createElement('button');
    const link = document.createElement('a');
    link.href = '#';
    const roleButton = document.createElement('div');
    roleButton.setAttribute('role', 'button');
    const summary = document.createElement('summary');

    for (const el of [button, link, roleButton, summary]) {
      expect(isInteractiveTarget(el)).toBe(true);
    }
  });

  it('matches descendants of an interactive control', () => {
    const button = document.createElement('button');
    const icon = document.createElement('span');
    button.appendChild(icon);

    expect(isInteractiveTarget(icon)).toBe(true);
  });

  it('does not match a plain container', () => {
    const div = document.createElement('div');
    const child = document.createElement('span');
    div.appendChild(child);

    expect(isInteractiveTarget(div)).toBe(false);
    expect(isInteractiveTarget(child)).toBe(false);
  });

  it('returns false for null and non-element targets', () => {
    expect(isInteractiveTarget(null)).toBe(false);
    expect(isInteractiveTarget(document as unknown as EventTarget)).toBe(false);
  });
});

describe('KeyboardShortcutService', () => {
  let service: KeyboardShortcutService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    service = TestBed.inject(KeyboardShortcutService);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  function keydown(init: KeyboardEventInit = {}, target: EventTarget = window): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  }

  it('invokes a matching handler and preventDefaults the event', () => {
    const handler = vi.fn();
    service.register('ArrowDown', handler);

    const event = keydown({ key: 'ArrowDown' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('normalizes the registered key (space)', () => {
    const handler = vi.fn();
    service.register(' ', handler);

    const event = keydown({ key: ' ' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('unregisters through the returned function', () => {
    const handler = vi.fn();
    const off = service.register('a', handler);
    off();

    keydown({ key: 'a' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores events originating from editable targets', () => {
    const handler = vi.fn();
    service.register('a', handler);
    const input = document.createElement('input');
    document.body.appendChild(input);

    try {
      keydown({ key: 'a' }, input);
    } finally {
      input.remove();
    }

    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores Space when a native button is focused', () => {
    const handler = vi.fn();
    service.register(' ', handler);
    const button = document.createElement('button');
    document.body.appendChild(button);

    try {
      const event = keydown({ key: ' ' }, button);
      expect(handler).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    } finally {
      button.remove();
    }
  });

  it('ignores Space when a role=button element is focused', () => {
    const handler = vi.fn();
    service.register(' ', handler);
    const roleButton = document.createElement('div');
    roleButton.setAttribute('role', 'button');
    document.body.appendChild(roleButton);

    try {
      keydown({ key: ' ' }, roleButton);
    } finally {
      roleButton.remove();
    }

    expect(handler).not.toHaveBeenCalled();
  });

  it('still dispatches arrow keys when a non-control target is focused', () => {
    const handler = vi.fn();
    service.register('ArrowDown', handler);
    const graphBody = document.createElement('div');
    document.body.appendChild(graphBody);

    try {
      const event = keydown({ key: 'ArrowDown' }, graphBody);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(true);
    } finally {
      graphBody.remove();
    }
  });

  it('ignores already-prevented events', () => {
    const handler = vi.fn();
    service.register('a', handler);

    const event = new KeyboardEvent('keydown', { key: 'a', cancelable: true });
    event.preventDefault();
    window.dispatchEvent(event);

    expect(handler).not.toHaveBeenCalled();
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { altKey: true }])(
    'ignores events with modifier %o',
    (mods) => {
      const handler = vi.fn();
      service.register('a', handler);

      keydown({ key: 'a', ...mods });

      expect(handler).not.toHaveBeenCalled();
    },
  );

  it('does not preventDefault when no binding matches', () => {
    service.register('a', vi.fn());

    const event = keydown({ key: 'z' });

    expect(event.defaultPrevented).toBe(false);
  });
});
