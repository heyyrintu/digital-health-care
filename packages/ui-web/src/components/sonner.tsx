'use client';

import type * as React from 'react';
import { Toaster as Sonner } from 'sonner';
import { cn } from '../lib/cn';

type ToasterProps = React.ComponentProps<typeof Sonner>;

/** Toasts. Light until the app has a dark mode switch. */
const Toaster = ({ theme = 'light', className, toastOptions, ...props }: ToasterProps) => {
  return (
    <Sonner
      theme={theme}
      className={cn('toaster group', className)}
      toastOptions={{
        ...toastOptions,
        classNames: {
          ...toastOptions?.classNames,
          toast: cn(
            'group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
            toastOptions?.classNames?.toast,
          ),
          description: cn(
            'group-[.toast]:text-muted-foreground',
            toastOptions?.classNames?.description,
          ),
          actionButton: cn(
            'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
            toastOptions?.classNames?.actionButton,
          ),
          cancelButton: cn(
            'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
            toastOptions?.classNames?.cancelButton,
          ),
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
