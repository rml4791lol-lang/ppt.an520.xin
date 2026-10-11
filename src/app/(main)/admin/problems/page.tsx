import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ProblemsClient } from '@/components/admin/problems-client';
import { getSessionByToken } from '@/lib/server/auth';
import { getEnv } from '@/lib/server/env';

export const metadata = {
  title: '问题日志 · AnPPT',
  robots: { index: false, follow: false },
};

export default async function AdminProblemsPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(getEnv().sessionCookieName)?.value;
  const session = token ? getSessionByToken(token) : null;
  if (!session) redirect('/login?next=%2Fadmin%2Fproblems');
  if (session.user.role !== 'admin') redirect('/');

  return <ProblemsClient admin={{ displayName: session.user.displayName }} />;
}
