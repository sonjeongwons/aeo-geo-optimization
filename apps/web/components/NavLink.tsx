"use client";

/**
 * NavLink — sidebar nav link with active-state awareness.
 *
 * W7.5 — Adds aria-current="page" (and an .active class) when the current
 * route matches, for accessibility and a visible active indicator. Kept as a
 * thin client component so the (app) layout can stay a Server Component.
 */

import { usePathname } from "next/navigation";

interface NavLinkProps {
  href: string;
  label: string;
}

export function NavLink({ href, label }: NavLinkProps) {
  const pathname = usePathname();
  // Exact match, or nested route (e.g. /reports/[id] under /reports).
  const isActive =
    pathname === href ||
    (href !== "/" && pathname.startsWith(`${href}/`));

  return (
    <a
      href={href}
      className={isActive ? "nav-link active" : "nav-link"}
      aria-current={isActive ? "page" : undefined}
    >
      {label}
    </a>
  );
}
