'use client';
import { useParams } from 'next/navigation';
import { PortalShell } from '../../../shell';
import { ProfileEditor } from '../../profile-editor';
export default function ProfilePage() {
  const { id } = useParams<{ id: string }>();
  return <PortalShell>{() => <ProfileEditor key={id} id={id} />}</PortalShell>;
}
