import "server-only";
import type { NextAuthOptions } from "next-auth";
import { getServerSession } from "next-auth/next";
import GoogleProvider from "next-auth/providers/google";
import { upsertUser } from "./db";

/**
 * Google 一键登录是首期唯一登录方式（PRD 4.3）。
 * 邮箱密码不做：增加成本、降低转化、带来密码安全责任。
 *
 * 没配 GOOGLE_CLIENT_ID 时不注册任何 provider——本地开发照样能跑，
 * 只是登录按钮点了会提示未配置。免费模板本来就不需要登录。
 */

const hasGoogle = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

export const authOptions: NextAuthOptions = {
  providers: hasGoogle
    ? [
        GoogleProvider({
          clientId: process.env.GOOGLE_CLIENT_ID!,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        }),
      ]
    : [],
  session: { strategy: "jwt" },
  callbacks: {
    async signIn({ user, account }) {
      // orders.user_id 有指向 users(id) 的外键，登录时不落库第一笔订单就会失败
      const id = account?.providerAccountId;
      if (id) {
        await upsertUser({ id, email: user.email, name: user.name, image: user.image });
      }
      return true;
    },
    async jwt({ token, account }) {
      // google sub 当用户主键，权益表就挂在它下面
      if (account?.providerAccountId) token.sub = account.providerAccountId;
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.sub) {
        (session.user as { id?: string }).id = token.sub;
      }
      return session;
    },
  },
};

export const authConfigured = hasGoogle;

export interface SessionUser {
  id: string;
  email?: string | null;
  name?: string | null;
  image?: string | null;
}

/** 未登录返回 null。免费模板 + 录制在未登录状态下必须可用（PRD 4.3）。 */
export async function currentUser(): Promise<SessionUser | null> {
  if (!hasGoogle) return null;
  const session = await getServerSession(authOptions);
  const user = session?.user as (SessionUser & { id?: string }) | undefined;
  if (!user?.id) return null;
  return { id: user.id, email: user.email, name: user.name, image: user.image };
}
