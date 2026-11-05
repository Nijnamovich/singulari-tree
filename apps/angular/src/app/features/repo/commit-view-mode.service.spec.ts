import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcBridge } from '../../core/services/ipc-bridge.service';
import { RepoState } from '../../core/services/repo-state.service';
import { CommitViewModeService } from './commit-view-mode.service';

function setup(): { service: CommitViewModeService; repoState: RepoState } {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: IpcBridge, useValue: { invoke: vi.fn(async () => ({})) } },
      RepoState,
      CommitViewModeService,
    ],
  });
  return {
    service: TestBed.inject(CommitViewModeService),
    repoState: TestBed.inject(RepoState),
  };
}

describe('CommitViewModeService', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('defaults to description', () => {
    const { service } = setup();
    expect(service.mode()).toBe('description');
  });

  it('setMode stores the picked segment', () => {
    const { service } = setup();
    service.setMode('files');
    expect(service.mode()).toBe('files');
  });

  it('reset returns to description', () => {
    const { service } = setup();
    service.setMode('files');
    service.reset();
    expect(service.mode()).toBe('description');
  });

  it('resets when the active repository changes', () => {
    const { service, repoState } = setup();
    service.setMode('files');

    repoState.activeId.set('repo-a');
    TestBed.tick();

    expect(service.mode()).toBe('description');
  });

  it('does not reset when the active repository is unchanged', () => {
    const { service, repoState } = setup();
    repoState.activeId.set('repo-a');
    TestBed.tick();
    service.setMode('files');

    repoState.activeId.set('repo-a');
    TestBed.tick();

    expect(service.mode()).toBe('files');
  });
});
