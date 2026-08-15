"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

function HomeIcon({ active }: { active: boolean }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={active ? 2.2 : 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 11.5 12 4l8 7.5" />
      <path d="M6 10.5V20h12v-9.5" />
    </svg>
  );
}

function CalendarIcon({ active }: { active: boolean }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={active ? 2.2 : 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4" y="5.5" width="16" height="15" rx="2" />
      <path d="M4 10h16M8 3.5v3M16 3.5v3" />
    </svg>
  );
}

function GridIcon({ active }: { active: boolean }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={active ? 2.2 : 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4" y="4" width="7" height="7" rx="1.2" />
      <rect x="13" y="4" width="7" height="7" rx="1.2" />
      <rect x="4" y="13" width="7" height="7" rx="1.2" />
      <rect x="13" y="13" width="7" height="7" rx="1.2" />
    </svg>
  );
}

function PlusIcon({ active }: { active: boolean }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={active ? 2.2 : 1.6}
      strokeLinecap="round"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function NavLink({
  href,
  label,
  active,
  children,
}: {
  href: string;
  label: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className={
        "flex w-16 flex-col items-center gap-1 py-2 text-[11px] " +
        (active ? "text-neutral-900" : "text-neutral-400")
      }
    >
      {children}
      <span>{label}</span>
    </Link>
  );
}

export default function BottomNav() {
  const pathname = usePathname();
  const isLooks = pathname === "/looks" || pathname?.startsWith("/looks/");
  const isAdd = pathname === "/add";

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-20 border-t border-neutral-100 bg-white/95 backdrop-blur"
      // safe-area-inset만으로는 홈 인디케이터에 너무 바짝 붙어 보여서
      // 여유 공간을 조금 더 얹는다 (layout.tsx의 viewport-fit: cover와
      // 함께 있어야 env() 값이 0이 아닌 실제 인셋으로 계산된다).
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 10px)" }}
    >
      <div className="mx-auto flex max-w-2xl items-center justify-around">
        <NavLink href="/" label="홈" active={pathname === "/"}>
          <HomeIcon active={pathname === "/"} />
        </NavLink>
        <NavLink href="/history" label="캘린더" active={pathname === "/history"}>
          <CalendarIcon active={pathname === "/history"} />
        </NavLink>
        <NavLink href="/add" label="추가" active={isAdd}>
          <PlusIcon active={isAdd} />
        </NavLink>
        <NavLink href="/looks" label="전체 룩" active={isLooks}>
          <GridIcon active={isLooks} />
        </NavLink>
      </div>
    </nav>
  );
}
