import { useState } from "react";
import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import { BrandHeader } from "../BrandHeader";
import { cn } from "../../lib/cn";
import { groupNavItems, NAV_ITEMS } from "./nav-items";
import { NavGroups } from "./NavGroups";
import { SearchTrigger } from "./SearchTrigger";
import { HelpMenu } from "./HelpMenu";
import { ThemeToggle } from "./ThemeToggle";
import { UserMenu } from "./UserMenu";

const STORAGE_KEY = "pontic-sidebar-collapsed";

export function Sidebar() {
  const { user, hasPermission } = useAuth();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(STORAGE_KEY) === "1");

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  }

  if (!user) return null;
  const groups = groupNavItems(NAV_ITEMS, { clinicId: user.clinicId, hasPermission });

  return (
    <aside className={cn("app-sidebar", collapsed && "app-sidebar--collapsed")}>
      <div className="app-sidebar-header">
        <BrandHeader iconOnly={collapsed} />
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Expandir menú" : "Colapsar menú"}
        >
          {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
        </button>
      </div>

      <div className="app-sidebar-search">
        <SearchTrigger iconsOnly={collapsed} />
      </div>

      <nav className="app-sidebar-nav" aria-label="Menú principal">
        <NavGroups groups={groups} iconsOnly={collapsed} />
      </nav>

      <div className="app-sidebar-footer">
        <HelpMenu collapsed={collapsed} />
        <ThemeToggle collapsed={collapsed} />
        <UserMenu collapsed={collapsed} />
      </div>
    </aside>
  );
}
