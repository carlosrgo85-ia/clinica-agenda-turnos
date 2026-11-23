import { useState } from "react";
import { Menu } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import { BrandHeader } from "../BrandHeader";
import { Sheet, SheetContent, SheetTitle } from "../ui/sheet";
import { groupNavItems, NAV_ITEMS } from "./nav-items";
import { NavGroups } from "./NavGroups";
import { SearchTrigger } from "./SearchTrigger";
import { HelpMenu } from "./HelpMenu";
import { ThemeToggle } from "./ThemeToggle";
import { UserMenu } from "./UserMenu";

export function MobileNav() {
  const { user, hasPermission } = useAuth();
  const [open, setOpen] = useState(false);

  if (!user) return null;
  const groups = groupNavItems(NAV_ITEMS, { clinicId: user.clinicId, hasPermission });

  return (
    <div className="app-mobile-topbar">
      <Sheet open={open} onOpenChange={setOpen}>
        <button type="button" className="btn btn--ghost btn--icon" onClick={() => setOpen(true)} aria-label="Abrir menú">
          <Menu size={18} />
        </button>
        <SheetContent side="left" className="mobile-nav-content">
          <SheetTitle className="sr-only">Menú de navegación</SheetTitle>
          <div className="app-sidebar-header" style={{ padding: 0, marginBottom: 16 }}>
            <BrandHeader />
          </div>
          <div className="app-sidebar-search" style={{ padding: 0, marginBottom: 8 }}>
            <SearchTrigger onOpen={() => setOpen(false)} />
          </div>
          <nav className="app-sidebar-nav" aria-label="Menú principal">
            <NavGroups groups={groups} onNavigate={() => setOpen(false)} />
          </nav>
          <div className="app-sidebar-footer" style={{ border: "none", marginTop: 16 }}>
            <HelpMenu />
            <ThemeToggle />
            <UserMenu />
          </div>
        </SheetContent>
      </Sheet>
      <BrandHeader />
      <div style={{ marginLeft: "auto" }}>
        <SearchTrigger iconsOnly />
      </div>
    </div>
  );
}
