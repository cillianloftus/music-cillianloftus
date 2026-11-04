declare namespace App {
  interface Locals {
    /** The signed-in user, or null for public visitors. Set by middleware. */
    user: import('./lib/auth/user').AppUser | null;
  }
}
