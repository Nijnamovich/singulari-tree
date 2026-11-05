import { ChangeDetectionStrategy, Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { PanelComponent } from './panel';

@Component({
  selector: 'st-panel-test-host',
  imports: [PanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <st-panel [stickyHeader]="sticky">
      <span header data-testid="projected-header">Changes</span>
      <p data-testid="projected-body">Body</p>
    </st-panel>
  `,
})
class PanelTestHost {
  sticky = true;
}

async function setup(sticky = true): Promise<ComponentFixture<PanelTestHost>> {
  await TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection()],
  }).compileComponents();
  const fixture = TestBed.createComponent(PanelTestHost);
  fixture.componentInstance.sticky = sticky;
  fixture.detectChanges();
  return fixture;
}

describe('PanelComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('projects the header slot into the header strip', async () => {
    const fixture = await setup();
    const el = fixture.nativeElement as HTMLElement;

    const header = el.querySelector('[data-testid="panel-header"]')!;
    expect(header.querySelector('[data-testid="projected-header"]')?.textContent).toContain('Changes');
    expect(el.querySelector('[data-testid="projected-body"]')?.textContent).toContain('Body');
  });

  it('sticks the header by default', async () => {
    const fixture = await setup(true);

    expect(
      (fixture.nativeElement as HTMLElement)
        .querySelector('[data-testid="panel-header"]')!
        .classList.contains('st-panel__header--sticky'),
    ).toBe(true);
  });

  it('drops the sticky class when disabled', async () => {
    const fixture = await setup(false);

    expect(
      (fixture.nativeElement as HTMLElement)
        .querySelector('[data-testid="panel-header"]')!
        .classList.contains('st-panel__header--sticky'),
    ).toBe(false);
  });
});
