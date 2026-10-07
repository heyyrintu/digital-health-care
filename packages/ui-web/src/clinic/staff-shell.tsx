'use client';

import { LogOut, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';
import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { Button } from '../components/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../components/command';
import { Dialog, DialogContent, DialogTitle } from '../components/dialog';
import { cn } from '../lib/cn';
import { useT } from '../locale';
import { Avatar } from './chips';

export interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** Active only on this exact path, not below it. */
  exact?: boolean;
}

/** The app's link component (Next's `Link`, say); a plain `<a>` by default. */
export type LinkComponent = ComponentType<{
  href: string;
  className?: string;
  title?: string;
  'aria-current'?: 'page';
  onClick?: () => void;
  children: ReactNode;
}>;

const PlainLink: LinkComponent = ({ children, ...props }) => <a {...props}>{children}</a>;

const isActive = (item: NavItem, path: string) =>
  item.exact ? path === item.href : path === item.href || path.startsWith(`${item.href}/`);

/**
 * The staff dashboard frame from the demo: a collapsible dark sidebar on desktop, a compact
 * top bar and scrolling nav on phones, optional bottom tabs, and Ctrl/⌘-K to jump to a page.
 * Sign-in, idle sign-out and the language switch stay with the app.
 */
export function StaffShell({
  brand,
  user,
  nav,
  bottomTabs,
  currentPath,
  onNavigate,
  onSignOut,
  headerEnd,
  Link = PlainLink,
  children,
}: {
  brand: { name: string; letter: string; subtitle?: string };
  user: { name: string; detail?: string };
  nav: NavItem[];
  /** Up to four items for a bottom tab bar on phones (the doctor's Home, Queue, ...). */
  bottomTabs?: NavItem[];
  currentPath: string;
  /** Called by the page search; use the router so the session survives. */
  onNavigate: (href: string) => void;
  onSignOut: () => void;
  /** Extra controls at the right of the top bar (language switch, role badge). */
  headerEnd?: ReactNode;
  Link?: LinkComponent;
  children: ReactNode;
}) {
  const t = useT();
  const [collapsed, setCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const tabHrefs = new Set(bottomTabs?.map((tab) => tab.href));

  return (
    <div className="flex min-h-screen bg-background font-sans text-foreground">
      <aside
        className={cn(
          'sticky top-0 hidden h-screen shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-300 md:flex',
          collapsed ? 'w-[76px] p-3' : 'w-64 p-4',
        )}
      >
        <div className="mb-7 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
          <span className="flex min-w-0 items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-sidebar-primary font-bold text-sidebar-primary-foreground">
              {brand.letter}
            </span>
            {!collapsed && (
              <span className="min-w-0 leading-tight">
                <span className="block truncate font-display font-bold">{brand.name}</span>
                {brand.subtitle && (
                  <span className="text-xs text-sidebar-foreground/60">{brand.subtitle}</span>
                )}
              </span>
            )}
          </span>
          {!collapsed && (
            <Button
              variant="ghost"
              size="icon"
              className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              onClick={() => setCollapsed(true)}
              aria-label={t('ui.collapseSidebar')}
            >
              <PanelLeftClose />
            </Button>
          )}
        </div>
        {collapsed && (
          <Button
            variant="ghost"
            size="icon"
            className="mb-4 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            onClick={() => setCollapsed(false)}
            aria-label={t('ui.expandSidebar')}
          >
            <PanelLeftOpen />
          </Button>
        )}
        <nav
          aria-label={t('ui.mainNav')}
          className="-mr-2 min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-2"
        >
          {nav.map((item) => {
            const active = isActive(item, currentPath);
            return (
              <Link
                key={item.href}
                href={item.href}
                title={collapsed ? item.label : undefined}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex min-h-11 items-center rounded-xl text-sm transition',
                  collapsed ? 'justify-center' : 'gap-3 px-3',
                  active
                    ? 'bg-sidebar-accent font-semibold text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground/75 hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground',
                )}
              >
                <item.icon className="h-5 w-5 shrink-0" />
                {collapsed ? (
                  <span className="sr-only">{item.label}</span>
                ) : (
                  <span className="truncate">{item.label}</span>
                )}
              </Link>
            );
          })}
        </nav>
        <div
          className={cn(
            'mt-3 shrink-0 border-t border-sidebar-border pt-4',
            collapsed ? 'flex justify-center' : 'rounded-2xl bg-sidebar-accent/45 p-3',
          )}
        >
          <div className="flex min-w-0 items-center gap-3">
            <Avatar
              name={user.name}
              className="ring-sidebar"
              label={collapsed ? user.name : undefined}
            />
            {!collapsed && (
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-semibold">{user.name}</p>
                {user.detail && (
                  <p className="truncate text-[10px] text-sidebar-foreground/55">{user.detail}</p>
                )}
              </div>
            )}
          </div>
          {!collapsed && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 w-full justify-start px-2 text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              onClick={onSignOut}
            >
              <LogOut className="mr-2 h-4 w-4" /> {t('session.signOut')}
            </Button>
          )}
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="glass sticky top-0 z-30 hidden h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b px-5 md:grid">
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="flex h-10 w-full max-w-md cursor-pointer items-center gap-2 rounded-xl border bg-card px-3 text-sm text-muted-foreground shadow-xs"
          >
            <Search className="h-4 w-4" aria-hidden />
            {t('ui.searchPlaceholder')}
            <kbd className="ml-auto rounded-md border bg-muted px-1.5 py-0.5 text-[10px]">
              Ctrl/⌘K
            </kbd>
          </button>
          <div className="flex shrink-0 items-center gap-2">{headerEnd}</div>
        </header>

        <div className="glass sticky top-0 z-30 flex items-center gap-2 border-b px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] md:hidden">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary font-bold text-primary-foreground">
            {brand.letter}
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-sm font-bold">{brand.name}</span>
            <span className="block truncate text-[11px] text-muted-foreground">{user.name}</span>
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setSearchOpen(true)}
            aria-label={t('common.search')}
          >
            <Search />
          </Button>
          {headerEnd}
          <Button variant="ghost" size="icon" onClick={onSignOut} aria-label={t('session.signOut')}>
            <LogOut />
          </Button>
        </div>
        <nav
          aria-label={t('ui.mainNav')}
          className="flex gap-2 overflow-x-auto border-b bg-background/80 p-2 md:hidden"
        >
          {nav
            .filter((item) => !tabHrefs.has(item.href))
            .map((item) => {
              const active = isActive(item, currentPath);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'min-h-10 whitespace-nowrap rounded-xl px-3 py-2 text-sm',
                    active && 'bg-accent font-semibold text-primary',
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
        </nav>

        <main
          className={cn(
            'mx-auto max-w-[1500px] p-4 md:p-6 xl:p-8',
            bottomTabs?.length && 'pb-28 md:pb-6',
          )}
        >
          {children}
        </main>

        {bottomTabs && bottomTabs.length > 0 && (
          <nav
            aria-label={t('ui.mainNav')}
            className="safe-bottom fixed inset-x-0 bottom-0 z-40 grid border-t bg-background shadow-sheet md:hidden"
            style={{ gridTemplateColumns: `repeat(${bottomTabs.length}, minmax(0, 1fr))` }}
          >
            {bottomTabs.map((tab) => {
              const active = isActive(tab, currentPath);
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex min-h-16 flex-col items-center justify-center gap-1 text-[11px] font-semibold',
                    active ? 'text-primary' : 'text-muted-foreground',
                  )}
                >
                  <span
                    className={cn(
                      'grid h-8 w-12 place-items-center rounded-full transition',
                      active && 'bg-accent',
                    )}
                  >
                    <tab.icon className="h-5 w-5" />
                  </span>
                  {tab.label}
                </Link>
              );
            })}
          </nav>
        )}
      </div>

      <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
        <DialogContent className="overflow-hidden p-0 sm:max-w-xl">
          <DialogTitle className="sr-only">{t('ui.searchPlaceholder')}</DialogTitle>
          <Command>
            <CommandInput placeholder={t('ui.searchPlaceholder')} />
            <CommandList>
              <CommandEmpty>{t('ui.noResults')}</CommandEmpty>
              <CommandGroup heading={t('ui.pages')}>
                {nav.map((item) => (
                  <CommandItem
                    key={item.href}
                    value={item.label}
                    onSelect={() => {
                      setSearchOpen(false);
                      onNavigate(item.href);
                    }}
                  >
                    <item.icon className="mr-2 h-4 w-4" />
                    {item.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </div>
  );
}
