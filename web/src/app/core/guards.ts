import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';
import { UserType } from './models';

export const authGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.init();
  return auth.profile() ? true : router.parseUrl('/login');
};

/** Route data: { roles: UserType[] } */
export const roleGuard: CanActivateFn = async (route) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.init();
  const roles = (route.data?.['roles'] ?? []) as UserType[];
  if (!auth.profile()) return router.parseUrl('/login');
  return !roles.length || auth.is(...roles) ? true : router.parseUrl('/');
};

export const guestGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.init();
  return auth.profile() ? router.parseUrl('/') : true;
};
