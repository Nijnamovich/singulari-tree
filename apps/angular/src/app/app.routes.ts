import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    redirectTo: 'repo',
    pathMatch: 'full',
  },
  {
    path: 'repo',
    loadChildren: () => import('./features/repo/repo.routes').then((m) => m.REPO_ROUTES),
  },
  {
    path: 'repos',
    loadChildren: () => import('./features/repos/repos.routes').then((m) => m.REPOS_ROUTES),
  },
  {
    path: 'github-account',
    loadChildren: () =>
      import('./features/github-account/github-account.routes').then((m) => m.GITHUB_ACCOUNT_ROUTES),
  },
  {
    path: 'settings',
    loadChildren: () => import('./features/settings/settings.routes').then((m) => m.SETTINGS_ROUTES),
  },
  {
    path: '**',
    redirectTo: 'repo',
  },
];
