import { Activity, Files } from "lucide-react";
import { Link } from "react-router";

import { routes } from "@/utils/routes";

const ITEMS = [
  {
    id: "content",
    label: "Content",
    to: routes.work.root,
    icon: Files,
  },
  {
    id: "retention",
    label: "Retention",
    to: routes.work.retention,
    icon: Activity,
  },
] as const;

export function WorkSectionNav({
  active,
}: {
  active: (typeof ITEMS)[number]["id"];
}) {
  return (
    <nav
      aria-label="Work views"
      className="flex w-fit items-center gap-1 rounded-lg bg-[var(--surface-lift)] p-1"
    >
      {ITEMS.map((item) => {
        const Icon = item.icon;
        const isActive = item.id === active;
        return (
          <Link
            key={item.id}
            to={item.to}
            aria-current={isActive ? "page" : undefined}
            className={`inline-flex min-h-9 items-center gap-2 rounded-md px-3 text-body-small-default transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${
              isActive
                ? "bg-[var(--surface-base)] text-[var(--content-emphasised)] shadow-sm"
                : "text-[var(--content-tertiary)] hover:text-[var(--content-default)]"
            }`}
          >
            <Icon className="size-4" aria-hidden="true" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
