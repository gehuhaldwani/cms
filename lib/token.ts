import { cache } from "react";
import { App, Octokit } from "octokit";
import { getAuth } from "@/lib/auth";
import { decrypt, encrypt } from "@/lib/crypto";
import { db } from "@/db";
import {
  collaboratorTable,
  githubUserTokenTable,
  githubInstallationTokenTable,
  subscriptionTable
} from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { User } from "@/types/user";

const getToken = cache(async (user: User, owner: string, repo: string) => {
  if (user.githubId) return await getUserToken();

  const subscription = await db.query.subscriptionTable.findFirst({
    where: and(
      eq(subscriptionTable.owner, owner),
      eq(subscriptionTable.status, "active"),
    ),
  });
  if (!subscription) throw new Error(`No active subscription found for "${owner}".`);

  const permission = await db.query.collaboratorTable.findFirst({
    where: and(
      eq(collaboratorTable.owner, owner),
      eq(collaboratorTable.repo, repo)
    )
  });
  if (!permission) throw new Error(`You do not have permission to access "${owner}/${repo}".`);

  const installationToken = await getInstallationToken(owner, repo);

  return installationToken
});

const getInstallationToken = cache(async (owner: string, repo: string) => {
  const app = new App({
		appId: process.env.GITHUB_APP_ID!,
		privateKey: process.env.GITHUB_APP_PRIVATE_KEY!,
	});

  const repoInstallation = await app.octokit.rest.apps.getRepoInstallation({ owner, repo });
  if (!repoInstallation) throw new Error(`Installation token not found for "${owner}/${repo}".`);

  let tokenData = await db.query.githubInstallationTokenTable.findFirst({
    where: eq(githubInstallationTokenTable.installationId, repoInstallation.data.id)
  });

  if (tokenData && Math.floor(Date.now() / 1000) < tokenData.expiresAt - 60) {
    const token = await decrypt(tokenData.ciphertext, tokenData.iv);
    if (!token) throw new Error(`Token could not be retrieved and/or decrypted.`);

    return token;
  }

  const installationToken = await app.octokit.rest.apps.createInstallationAccessToken({
    installation_id: repoInstallation.data.id
  });

  const { ciphertext, iv } = await encrypt(installationToken.data.token);
    
  const expiresAt = Math.floor(new Date(installationToken.data.expires_at).getTime() / 1000)

  if (tokenData) {
    await db.update(githubInstallationTokenTable).set({
      ciphertext,
      iv,
      expiresAt
    }).where(
      eq(githubInstallationTokenTable.id, tokenData.id)
    );
  } else {
    await db.insert(githubInstallationTokenTable).values({
      ciphertext,
      iv,
      installationId: repoInstallation.data.id,
      expiresAt
    }).returning();
  }

  return installationToken.data.token;
});

const getUserToken = cache(async () => {
  const { user } = await getAuth();
	if (!user) throw new Error("User not found");
  if (!user.githubId) throw new Error("User must be logged in with Github");
  
  let token;
  
  const tokenData = await db.query.githubUserTokenTable.findFirst({
    where: eq(githubUserTokenTable.userId, user.id)
  });
  if (!tokenData) throw new Error(`Token not found for user ${user.id}.`);
  
  token = await decrypt(tokenData.ciphertext, tokenData.iv);
  if (!token) throw new Error(`Token could not be retrieved and/or decrypted.`);

  return token;
});

export { getInstallationToken, getUserToken, getToken };