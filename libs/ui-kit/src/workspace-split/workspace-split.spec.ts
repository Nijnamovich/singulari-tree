import { ChangeDetectionStrategy, Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceSplitComponent } from './workspace-split';

@Component({
  selector: 'st-workspace-split-test-host',
  imports: [WorkspaceSplitComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <st-workspace-split
      [showDetail]="showDetail"
      [detailWidth]="detailWidth()"
      [resizable]="resizable"
      detailTitle="Commit"
      (detailWidthResized)="onResized($event)"
    >
      <div detail data-testid="projected-detail">detail</div>
      <div data-testid="projected-primary">primary</div>
    </st-workspace-split>
  `,
})
class WorkspaceSplitTestHost {
  showDetail = false;
  readonly detailWidth = signal<string | null>(null);
  resizable = false;
  /** Round-trips the `detailWidthResized` output so the template wiring is proved. */
  lastResized: number | null = null;

  protected onResized(width: number): void {
    this.lastResized = width;
  }
}

async function setup(
  showDetail = false,
  opts: { detailWidth?: string | null; resizable?: boolean } = {},
): Promise<ComponentFixture<WorkspaceSplitTestHost>> {
  await TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection()],
  }).compileComponents();
  const fixture = TestBed.createComponent(WorkspaceSplitTestHost);
  fixture.componentInstance.showDetail = showDetail;
  fixture.componentInstance.detailWidth.set(opts.detailWidth ?? null);
  fixture.componentInstance.resizable = opts.resizable ?? false;
  fixture.detectChanges();
  return fixture;
}

function el(fixture: ComponentFixture<WorkspaceSplitTestHost>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

/** The `<st-workspace-split>` host element (carries the `data-resizing` attribute). */
function splitEl(fixture: ComponentFixture<WorkspaceSplitTestHost>): HTMLElement {
  return el(fixture).querySelector<HTMLElement>('st-workspace-split') as HTMLElement;
}

function detail(fixture: ComponentFixture<WorkspaceSplitTestHost>): HTMLElement {
  return el(fixture).querySelector<HTMLElement>(
    '[data-testid="workspace-detail"]',
  ) as HTMLElement;
}

function divider(fixture: ComponentFixture<WorkspaceSplitTestHost>): HTMLElement | null {
  return el(fixture).querySelector<HTMLElement>('[data-testid="workspace-divider"]');
}

function split(fixture: ComponentFixture<WorkspaceSplitTestHost>): WorkspaceSplitComponent {
  return fixture.debugElement.query(By.directive(WorkspaceSplitComponent))
    .componentInstance as WorkspaceSplitComponent;
}

/** The divider's DebugElement, to invoke its listeners without a real pointer. */
function dividerDebug(fixture: ComponentFixture<WorkspaceSplitTestHost>) {
  return fixture.debugElement.query(By.css('.st-workspace-split__divider'));
}

/**
 * Fire a pointer handler with a fake event. jsdom implements no pointer
 * capture, so `currentTarget` is faked with the real divider element and the
 * component's `typeof setPointerCapture === 'function'` guard does the rest.
 */
function pointer(
  fixture: ComponentFixture<WorkspaceSplitTestHost>,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  overrides: { pointerId?: number; clientX?: number } = {},
): void {
  dividerDebug(fixture).triggerEventHandler(type, {
    pointerId: overrides.pointerId ?? 1,
    clientX: overrides.clientX ?? 0,
    currentTarget: divider(fixture),
    preventDefault: () => {},
  } as unknown as PointerEvent);
}

function key(
  fixture: ComponentFixture<WorkspaceSplitTestHost>,
  keyName: string,
  shiftKey = false,
): void {
  dividerDebug(fixture).triggerEventHandler('keydown', {
    key: keyName,
    shiftKey,
    preventDefault: () => {},
  } as unknown as KeyboardEvent);
}

/** jsdom reports `clientWidth` 0; stub a real viewport to exercise the upper clamp. */
function setHostWidth(fixture: ComponentFixture<WorkspaceSplitTestHost>, width: number): void {
  Object.defineProperty(splitEl(fixture), 'clientWidth', { value: width, configurable: true });
}

describe('WorkspaceSplitComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders only the primary pane when the detail is hidden', async () => {
    const fixture = await setup(false);

    expect(el(fixture).querySelector('[data-testid="workspace-detail"]')).toBeNull();
    expect(el(fixture).querySelector('[data-testid="projected-primary"]')).not.toBeNull();
  });

  it('renders the pinned detail pane, its header and the projected detail', async () => {
    const fixture = await setup(true);

    expect(el(fixture).querySelector('[data-testid="workspace-detail"]')).not.toBeNull();
    expect(el(fixture).querySelector('[data-testid="workspace-detail-header"]')?.textContent).toContain(
      'Commit',
    );
    expect(el(fixture).querySelector('[data-testid="projected-detail"]')).not.toBeNull();
    expect(el(fixture).querySelector('[data-testid="projected-primary"]')).not.toBeNull();
  });

  // -- opt-in resize divider (plan 4.9) ------------------------------------

  it('renders no resize divider unless resizable is opted in', async () => {
    const fixture = await setup(true);

    // The divider is purely additive: the pinned pane still renders without it.
    expect(divider(fixture)).toBeNull();
    expect(detail(fixture)).not.toBeNull();
  });

  it('renders the divider inside the detail pane with vertical-separator ARIA when resizable', async () => {
    const fixture = await setup(true, { resizable: true });
    const handle = divider(fixture);

    expect(handle).not.toBeNull();
    expect(handle!.getAttribute('role')).toBe('separator');
    expect(handle!.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle!.getAttribute('tabindex')).toBe('0');
    expect(handle!.getAttribute('aria-label')).toBe('Resize detail pane');
    expect(handle!.getAttribute('aria-valuemin')).toBe('320');
    // jsdom reports no layout, so the upper clamp collapses onto the 320 minimum.
    expect(handle!.getAttribute('aria-valuemax')).toBe('320');
    expect(handle!.getAttribute('aria-valuenow')).toBe('380');
    // The handle lives at the detail pane's right edge, never in the primary pane.
    expect(detail(fixture).contains(handle!)).toBe(true);
  });

  it('ignores pointer and keyboard input when the divider is not opted in', async () => {
    const fixture = await setup(true);
    const component = split(fixture);
    const emit = vi.spyOn(component.detailWidthResized, 'emit');

    component.onPointerDown({
      pointerId: 1,
      clientX: 0,
      currentTarget: detail(fixture),
      preventDefault: () => {},
    } as unknown as PointerEvent);
    component.onKeyDown({
      key: 'ArrowRight',
      shiftKey: false,
      preventDefault: () => {},
    } as KeyboardEvent);

    expect(component.resizing()).toBe(false);
    expect(component.currentWidth()).toBe(380);
    expect(emit).not.toHaveBeenCalled();
  });

  // -- detail pane width: token fallback vs explicit px ---------------------

  it('falls back to the --st-size-detail-pane token when detailWidth is null', async () => {
    const fixture = await setup(true, { resizable: true });

    expect(detail(fixture).style.width).toBe('var(--st-size-detail-pane)');
  });

  it('honours an explicit px detailWidth input', async () => {
    const fixture = await setup(true, { resizable: true, detailWidth: '420px' });

    expect(detail(fixture).style.width).toBe('420px');
    expect(divider(fixture)!.getAttribute('aria-valuenow')).toBe('420');
  });

  it('honours any CSS length but reports the 380px default as aria-valuenow', async () => {
    const fixture = await setup(true, { resizable: true, detailWidth: '50%' });

    // The input is a CSS *length*, so a percentage still sizes the pane.
    expect(detail(fixture).style.width).toBe('50%');
    // Only the pixel number is unknown, so the default is reported to AT.
    expect(divider(fixture)!.getAttribute('aria-valuenow')).toBe('380');
  });

  // -- pointer drag --------------------------------------------------------

  it('updates the live inline width on a pointer drag and emits the settled width', async () => {
    const fixture = await setup(true, { resizable: true, detailWidth: '420px' });
    setHostWidth(fixture, 1200); // maxWidth() = 1200 - 320 = 880
    const host = fixture.componentInstance;

    pointer(fixture, 'pointerdown', { clientX: 0 });
    fixture.detectChanges();
    // The pane has no layout in jsdom, so the drag start is the parsed input.
    expect(split(fixture).resizing()).toBe(true);
    expect(splitEl(fixture).getAttribute('data-resizing')).toBe('true');
    expect(divider(fixture)!.getAttribute('data-resizing')).toBe('true');

    pointer(fixture, 'pointermove', { clientX: 400 });
    fixture.detectChanges();
    expect(detail(fixture).style.width).toBe('820px');
    expect(divider(fixture)!.getAttribute('aria-valuenow')).toBe('820');
    expect(host.lastResized).toBeNull();

    pointer(fixture, 'pointerup', { clientX: 400 });
    fixture.detectChanges();
    expect(split(fixture).resizing()).toBe(false);
    expect(splitEl(fixture).getAttribute('data-resizing')).toBeNull();
    expect(host.lastResized).toBe(820);
  });

  it('clamps a pointer drag to the 320px floor and the primary-pane ceiling', async () => {
    const fixture = await setup(true, { resizable: true, detailWidth: '420px' });
    setHostWidth(fixture, 1200); // maxWidth() = 880

    pointer(fixture, 'pointerdown', { clientX: 0 });

    pointer(fixture, 'pointermove', { clientX: 3000 });
    fixture.detectChanges();
    expect(detail(fixture).style.width).toBe('880px');

    pointer(fixture, 'pointermove', { clientX: -3000 });
    fixture.detectChanges();
    expect(detail(fixture).style.width).toBe('320px');

    pointer(fixture, 'pointerup', { clientX: -3000 });
    expect(fixture.componentInstance.lastResized).toBe(320);
  });

  it('clamps every drag to 320px in jsdom, where the host reports no layout', async () => {
    const fixture = await setup(true, { resizable: true, detailWidth: '420px' });
    // No stubbed width: clientWidth stays 0, so maxWidth() collapses to 320.
    expect(split(fixture).maxWidth()).toBe(320);

    pointer(fixture, 'pointerdown', { clientX: 0 });
    pointer(fixture, 'pointermove', { clientX: 500 });
    fixture.detectChanges();
    expect(detail(fixture).style.width).toBe('320px');

    pointer(fixture, 'pointerup', { clientX: 500 });
    expect(fixture.componentInstance.lastResized).toBe(320);
  });

  it('settles an in-flight drag on pointercancel as well', async () => {
    const fixture = await setup(true, { resizable: true, detailWidth: '420px' });
    setHostWidth(fixture, 1200);

    pointer(fixture, 'pointerdown', { clientX: 0 });
    pointer(fixture, 'pointermove', { clientX: 200 });
    pointer(fixture, 'pointercancel', { clientX: 200 });
    fixture.detectChanges();

    expect(split(fixture).resizing()).toBe(false);
    expect(fixture.componentInstance.lastResized).toBe(620);
  });

  it('ignores pointer moves from another pointer and before any drag starts', async () => {
    const fixture = await setup(true, { resizable: true, detailWidth: '420px' });

    pointer(fixture, 'pointermove', { clientX: 500 });
    fixture.detectChanges();
    expect(detail(fixture).style.width).toBe('420px');

    pointer(fixture, 'pointerdown', { clientX: 0, pointerId: 1 });
    pointer(fixture, 'pointermove', { clientX: 500, pointerId: 2 });
    fixture.detectChanges();
    // A move from a different pointer never becomes the live width.
    expect(detail(fixture).style.width).toBe('420px');
    expect(fixture.componentInstance.lastResized).toBeNull();
  });

  // -- keyboard ------------------------------------------------------------

  it('steps the pane width from the keyboard (Arrow, Shift, Home, End)', async () => {
    const fixture = await setup(true, { resizable: true, detailWidth: '380px' });
    setHostWidth(fixture, 1200); // maxWidth() = 880
    const host = fixture.componentInstance;

    key(fixture, 'ArrowRight');
    fixture.detectChanges();
    expect(detail(fixture).style.width).toBe('396px');
    expect(host.lastResized).toBe(396);

    key(fixture, 'ArrowRight', true); // Shift = coarse steps of 64.
    fixture.detectChanges();
    expect(detail(fixture).style.width).toBe('460px');
    expect(host.lastResized).toBe(460);

    key(fixture, 'ArrowLeft');
    fixture.detectChanges();
    expect(detail(fixture).style.width).toBe('444px');

    key(fixture, 'Home'); // Minimum.
    fixture.detectChanges();
    expect(detail(fixture).style.width).toBe('320px');
    expect(divider(fixture)!.getAttribute('aria-valuenow')).toBe('320');

    key(fixture, 'ArrowLeft'); // Already at the floor: clamped, never negative.
    fixture.detectChanges();
    expect(detail(fixture).style.width).toBe('320px');

    key(fixture, 'End'); // Upper clamp.
    fixture.detectChanges();
    expect(detail(fixture).style.width).toBe('880px');
    expect(host.lastResized).toBe(880);
  });

  it('clamps keyboard steps to 320px in jsdom, where the host reports no layout', async () => {
    const fixture = await setup(true, { resizable: true });
    const host = fixture.componentInstance;

    key(fixture, 'ArrowRight');
    fixture.detectChanges();
    expect(detail(fixture).style.width).toBe('320px');

    key(fixture, 'End');
    fixture.detectChanges();
    expect(split(fixture).maxWidth()).toBe(320);
    expect(detail(fixture).style.width).toBe('320px');
    expect(host.lastResized).toBe(320);
  });

  it('ignores keys that are not resize shortcuts', async () => {
    const fixture = await setup(true, { resizable: true, detailWidth: '420px' });

    key(fixture, 'a');
    key(fixture, 'ArrowUp');
    fixture.detectChanges();

    expect(detail(fixture).style.width).toBe('420px');
    expect(fixture.componentInstance.lastResized).toBeNull();
  });

  // -- an external width change wins over a local drag override -----------

  it('clears a local drag override when the external detailWidth input changes', async () => {
    const fixture = await setup(true, { resizable: true, detailWidth: '420px' });
    setHostWidth(fixture, 1200);

    key(fixture, 'Home');
    fixture.detectChanges();
    // The local override is in flight.
    expect(detail(fixture).style.width).toBe('320px');
    expect(fixture.componentInstance.lastResized).toBe(320);

    // A restored (or reset) preference must win over the finished drag.
    fixture.componentInstance.detailWidth.set('500px');
    fixture.detectChanges();
    TestBed.tick();
    fixture.detectChanges();
    expect(detail(fixture).style.width).toBe('500px');
    expect(divider(fixture)!.getAttribute('aria-valuenow')).toBe('500');
  });
});
