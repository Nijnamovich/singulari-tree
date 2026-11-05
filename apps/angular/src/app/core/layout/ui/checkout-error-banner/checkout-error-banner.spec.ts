import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppError } from '@core/services/ipc-bridge.service';
import { CheckoutErrorBanner } from './checkout-error-banner';

async function setup(error: AppError | null): Promise<ComponentFixture<CheckoutErrorBanner>> {
  await TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection()],
  }).compileComponents();

  const fixture = TestBed.createComponent(CheckoutErrorBanner);
  fixture.componentRef.setInput('error', error);
  fixture.detectChanges();
  return fixture;
}

function query<T extends Element>(
  fixture: ComponentFixture<CheckoutErrorBanner>,
  testId: string,
): T | null {
  return (fixture.nativeElement as HTMLElement).querySelector<T>(`[data-testid="${testId}"]`);
}

function all(fixture: ComponentFixture<CheckoutErrorBanner>, testId: string): Element[] {
  return Array.from(
    (fixture.nativeElement as HTMLElement).querySelectorAll(`[data-testid="${testId}"]`),
  );
}

describe('CheckoutErrorBanner', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders nothing when the error is null', async () => {
    const fixture = await setup(null);

    expect(query(fixture, 'checkout-error-banner')).toBeNull();
    expect(query(fixture, 'checkout-error-message')).toBeNull();
    expect(query(fixture, 'checkout-error-dismiss')).toBeNull();
  });

  it('renders the headline and one list item per conflicting path', async () => {
    const fixture = await setup({
      code: 'CHECKOUT_FAILED',
      message: 'Your local changes would be overwritten by checkout.',
      details: {
        reason: 'dirty_working_tree',
        paths: 'src/a.ts\nsrc/b.ts\ndocs/readme.md',
      },
    });

    expect(query(fixture, 'checkout-error-message')?.textContent).toContain(
      'Your local changes would be overwritten by checkout.',
    );
    expect(query(fixture, 'checkout-error-paths')).not.toBeNull();
    expect(all(fixture, 'checkout-error-path').map((el) => el.textContent?.trim())).toEqual([
      'src/a.ts',
      'src/b.ts',
      'docs/readme.md',
    ]);
    // Raw diagnostics must never leak into the primary UI.
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('ST_APP_ERROR');
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('exit status');
  });

  it('renders duplicate conflicting paths without throwing', async () => {
    const fixture = await setup({
      code: 'CHECKOUT_FAILED',
      message: 'Your local changes would be overwritten by checkout.',
      details: {
        reason: 'dirty_working_tree',
        paths: 'a.ts\na.ts',
      },
    });

    expect(all(fixture, 'checkout-error-path')).toHaveLength(2);
    expect(all(fixture, 'checkout-error-path').map((el) => el.textContent?.trim())).toEqual([
      'a.ts',
      'a.ts',
    ]);
  });

  it('omits the path list when details are missing', async () => {
    const fixture = await setup({ code: 'CHECKOUT_FAILED', message: 'Checkout failed' });

    expect(query(fixture, 'checkout-error-message')?.textContent).toContain('Checkout failed');
    expect(query(fixture, 'checkout-error-paths')).toBeNull();
    expect(all(fixture, 'checkout-error-path')).toHaveLength(0);
  });

  it('omits the path list when details.paths is not a string', async () => {
    const fixture = await setup({
      code: 'CHECKOUT_FAILED',
      message: 'Checkout failed',
      details: { paths: ['src/a.ts'] },
    });

    expect(query(fixture, 'checkout-error-paths')).toBeNull();
    expect(all(fixture, 'checkout-error-path')).toHaveLength(0);
  });

  it('emits dismiss when the dismiss button is clicked', async () => {
    const fixture = await setup({ code: 'CHECKOUT_FAILED', message: 'Checkout failed' });
    const emitted: void[] = [];
    fixture.componentInstance.dismiss.subscribe(() => emitted.push(undefined));

    query<HTMLButtonElement>(fixture, 'checkout-error-dismiss')!.click();

    expect(emitted).toHaveLength(1);
  });
});
