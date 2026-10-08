/**
 * @dhc/ui-web: the design system for the web app (Build Plan 4.2), from the approved demo.
 * shadcn/ui primitives plus clinic components. Styling comes from @dhc/tokens' theme; apps add
 * `@import '@dhc/ui-web/styles.css';` to their Tailwind entry and wrap pages in UiLocaleProvider.
 */
export { cn } from './lib/cn';
export { UiLocaleProvider, useT, useUiLocale } from './locale';

// shadcn/ui primitives
export * from './components/alert-dialog';
export * from './components/badge';
export * from './components/button';
export * from './components/calendar';
export * from './components/card';
export * from './components/checkbox';
export * from './components/command';
export * from './components/dialog';
export * from './components/drawer';
export * from './components/dropdown-menu';
export * from './components/input-otp';
export * from './components/input';
export * from './components/label';
export * from './components/popover';
export * from './components/radio-group';
export * from './components/scroll-area';
export * from './components/select';
export * from './components/separator';
export * from './components/sheet';
export * from './components/skeleton';
export * from './components/sonner';
export * from './components/switch';
export * from './components/table';
export * from './components/tabs';
export * from './components/textarea';
export * from './components/tooltip';

// Clinic components
export * from './clinic/layout';
export * from './clinic/feedback';
export * from './clinic/form';
export * from './clinic/chips';
export * from './clinic/timeline';
export * from './clinic/actions';
export * from './clinic/slot-picker';
export * from './clinic/staff-shell';
