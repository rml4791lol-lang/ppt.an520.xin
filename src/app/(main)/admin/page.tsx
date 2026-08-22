import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { AdminClient } from '@/components/admin/admin-client';
import { getSessionByToken } from '@/lib/server/auth';
import { getEnv } from '@/lib/server/env';

export const metadata = {
  title: '系统管理 · AnPPT',
  robots: { index: false, follow: false },
};

export default async function AdminPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(getEnv().sessionCookieName)?.value;
  const session = token ? getSessionByToken(token) : null;
  if (!session) redirect('/login?next=%2Fadmin');
  if (session.user.role !== 'admin') redirect('/');

  return (
    <AdminClient
      admin={{
        id: session.user.id,
        displayName: session.user.displayName,
        email: session.user.email,
      }}
    />
  );
}
