import { Routes } from '@angular/router';

export const GITHUB_ACCOUNT_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./github-account').then((m) => m.GithubAccount),
  },
];
