import type { Slot } from '@dhc/contracts';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { Home, ListOrdered } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { Dialog, DialogContent, DialogTitle } from '../components/dialog';
import { UiLocaleProvider } from '../locale';
import { Avatar, ModeTag, StatusChip, TagChip } from './chips';
import { EmptyState, Stat } from './feedback';
import { Field } from './form';
import { SlotPicker } from './slot-picker';
import { StaffShell } from './staff-shell';
import { Timeline } from './timeline';

const slot = (startTime: string, extra: Partial<Slot> = {}): Slot => ({
  start: `2026-10-08T${startTime}:00+05:30`,
  end: `2026-10-08T${startTime}:00+05:30`,
  startTime,
  endTime: startTime,
  available: true,
  ...extra,
});

describe('chips', () => {
  it('names statuses and modes in the UI language', () => {
    render(
      <UiLocaleProvider locale="hi">
        <StatusChip status="checked_in" />
        <ModeTag mode="video" />
      </UiLocaleProvider>,
    );
    expect(screen.getByText('चेक-इन हो गया')).toBeTruthy();
    expect(screen.getByText(/वीडियो कॉल/)).toBeTruthy();
  });

  it('defaults to English and shows the tag colour as a CSS variable', () => {
    const { container } = render(<TagChip name="Diabetic" colour="#dc2626" />);
    expect(screen.getByText('Diabetic')).toBeTruthy();
    expect((container.firstChild as HTMLElement).style.getPropertyValue('--tag')).toBe('#dc2626');
    render(<StatusChip status="no_show" />);
    expect(screen.getByText('No-show')).toBeTruthy();
  });

  it('builds initials from the first two names', () => {
    render(<Avatar name="siddharth  kumar gupta" />);
    expect(screen.getByText('SK')).toBeTruthy();
  });
});

describe('feedback and forms', () => {
  it('gives an empty state a default title', () => {
    render(<EmptyState />);
    expect(screen.getByText('Nothing here yet.')).toBeTruthy();
  });

  it('makes a stat a button only when it does something', () => {
    const onClick = vi.fn();
    render(
      <>
        <Stat label="Waiting" value={4} />
        <Stat label="Seen" value={9} onClick={onClick} />
      </>,
    );
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalled();
  });

  it('labels the control and announces the error in place of the hint', () => {
    render(
      <Field label="Mobile" hint="10 digits" error="Enter 10 digits">
        <input />
      </Field>,
    );
    expect(screen.getByLabelText(/Mobile/)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('Enter 10 digits');
    expect(screen.queryByText('10 digits')).toBeNull();
  });

  it('lists status history with who made each change', () => {
    render(<Timeline items={[{ status: 'confirmed', actor: 'Asha', when: '8 Oct, 10:00' }]} />);
    expect(screen.getByText('by Asha')).toBeTruthy();
    expect(screen.getByText('Booked')).toBeTruthy();
  });
});

describe('SlotPicker', () => {
  const slots = [
    slot('09:00'),
    slot('11:45', { available: false, unavailableReason: 'busy' }),
    slot('14:00', { available: false, unavailableReason: 'past' }),
    slot('18:30'),
  ];

  it('groups slots by part of day and only lets free ones be chosen', () => {
    const onSelect = vi.fn();
    render(<SlotPicker slots={slots} onSelect={onSelect} />);
    const morning = screen.getByRole('region', { name: 'Morning' });
    expect(within(morning).getAllByRole('button')).toHaveLength(2);
    expect(screen.getByRole('region', { name: 'Evening' })).toBeTruthy();
    expect((screen.getByText('11:45').closest('button') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('18:30'));
    expect(onSelect).toHaveBeenCalledWith(slots[3]);
  });

  it('lets staff pick a taken slot when overbooking, and marks it', () => {
    const onSelect = vi.fn();
    render(
      <SlotPicker
        slots={slots}
        onSelect={onSelect}
        canChoose={(s) => s.available || s.unavailableReason === 'busy'}
        selected={slots[0]!.start}
      />,
    );
    const taken = screen.getByText('11:45').closest('button') as HTMLButtonElement;
    expect(taken.disabled).toBe(false);
    expect(within(taken).getByText('taken')).toBeTruthy();
    expect(screen.getByText('09:00').closest('button')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('shows why a day has no slots', () => {
    render(<SlotPicker slots={[]} onSelect={() => {}} closedMessage="The doctor is on leave." />);
    expect(screen.getByText('The doctor is on leave.')).toBeTruthy();
  });
});

describe('StaffShell', () => {
  const nav = [
    { href: '/clinic', label: 'Home', icon: Home, exact: true },
    { href: '/clinic/queue', label: 'Queue', icon: ListOrdered },
  ];

  it('marks the current page and signs out', () => {
    const onSignOut = vi.fn();
    render(
      <StaffShell
        brand={{ name: 'Demo Clinic', letter: 'D' }}
        user={{ name: 'Asha Rao' }}
        nav={nav}
        currentPath="/clinic/queue/today"
        onNavigate={() => {}}
        onSignOut={onSignOut}
      >
        <p>content</p>
      </StaffShell>,
    );
    const current = screen.getAllByRole('link', { current: 'page' });
    expect(current.every((link) => link.getAttribute('href') === '/clinic/queue')).toBe(true);
    expect(screen.getByText('content')).toBeTruthy();
    // Pages have their own "Search" buttons; the shell's page jump must not match that name.
    expect(screen.queryAllByRole('button', { name: /search/i })).toHaveLength(0);
    expect(screen.getAllByRole('button', { name: 'Jump to a page' }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: 'Sign out' })[0]!);
    expect(onSignOut).toHaveBeenCalled();
  });

  it('opens page search with Ctrl+K and navigates through the app', () => {
    const onNavigate = vi.fn();
    render(
      <StaffShell
        brand={{ name: 'Demo Clinic', letter: 'D' }}
        user={{ name: 'Asha Rao' }}
        nav={nav}
        currentPath="/clinic"
        onNavigate={onNavigate}
        onSignOut={() => {}}
      >
        <p>content</p>
      </StaffShell>,
    );
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByText('Queue'));
    expect(onNavigate).toHaveBeenCalledWith('/clinic/queue');
  });
});

describe('Dialog', () => {
  it('labels the close button in the UI language', () => {
    render(
      <UiLocaleProvider locale="hi">
        <Dialog open>
          <DialogContent>
            <DialogTitle>शीर्षक</DialogTitle>
          </DialogContent>
        </Dialog>
      </UiLocaleProvider>,
    );
    expect(screen.getByRole('button', { name: 'बंद करें' })).toBeTruthy();
  });
});
