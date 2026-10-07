'use client';

import type { ComponentType, ReactNode } from 'react';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '../components/drawer';
import { cn } from '../lib/cn';

/** The demo's action sheet: slides up from the bottom, centred and narrower on desktop. */
export function BottomSheet({
  open,
  onClose,
  title,
  sub,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  sub?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Drawer open={open} onOpenChange={(next) => !next && onClose()}>
      <DrawerContent className={cn('mx-auto w-full', wide ? 'max-w-3xl' : 'max-w-lg')}>
        <DrawerHeader className="pb-2 text-left">
          <DrawerTitle>{title}</DrawerTitle>
          {sub ? (
            <DrawerDescription>{sub}</DrawerDescription>
          ) : (
            <DrawerDescription className="sr-only">{title}</DrawerDescription>
          )}
        </DrawerHeader>
        <div className="overflow-y-auto px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          {children}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

/** A large square button with an icon, for action grids in sheets. */
export function ActionTile({
  icon: Icon,
  label,
  onClick,
  tone,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  tone?: 'danger';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex min-h-[72px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-2xl bg-muted/60 p-2 text-center text-xs font-semibold transition hover:bg-accent active:scale-[.98]',
        tone === 'danger' && 'text-destructive',
      )}
    >
      <Icon className="h-5 w-5" />
      {label}
    </button>
  );
}
