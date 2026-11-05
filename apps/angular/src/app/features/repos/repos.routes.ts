import { Routes } from '@angular/router';

export const REPOS_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./repos-page').then((m) => m.ReposPage),
  },
];
