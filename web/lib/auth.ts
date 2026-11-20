// ログインまわり。本番は Amazon Cognito（Amplify のライブラリ）、お試しモードはブラウザの中だけ。
// 画面からは、どちらでも同じ関数で使える。

import { config } from "./config";

export type SignInResult = "done" | "newPasswordRequired";

export interface Auth {
  /** ログイン中ならメールアドレス、していなければ null */
  currentUser(): Promise<string | null>;
  signIn(email: string, password: string): Promise<SignInResult>;
  /** 初めてのログインで「新しいパスワードを決めてね」と言われたとき */
  completeNewPassword(newPassword: string): Promise<void>;
  /** パスワードを忘れたとき：メールで確認コードを送る */
  requestPasswordReset(email: string): Promise<void>;
  confirmPasswordReset(email: string, code: string, newPassword: string): Promise<void>;
  signOut(): Promise<void>;
  /** API に付ける通行証（アクセストークン） */
  accessToken(): Promise<string | null>;
}

/** ログインの失敗を、やさしい日本語にする */
export class AuthError extends Error {}

function friendlyAuthError(e: unknown): AuthError {
  const name = (e as { name?: string })?.name ?? "";
  const messages: Record<string, string> = {
    NotAuthorizedException: "メールアドレスかパスワードがちがいます",
    UserNotFoundException: "メールアドレスかパスワードがちがいます",
    InvalidPasswordException: "パスワードは12文字以上で、英大文字・英小文字・数字をまぜてください",
    InvalidParameterException: "入力を確かめてください",
    CodeMismatchException: "確認コードがちがいます",
    ExpiredCodeException: "確認コードの期限が切れました。もう一度送ってください",
    LimitExceededException: "何回もためしたので、しばらく待ってからもう一度ためしてください",
    TooManyRequestsException: "何回もためしたので、しばらく待ってからもう一度ためしてください",
    UserAlreadyAuthenticatedException: "すでにログインしています",
  };
  return new AuthError(messages[name] ?? "うまくいきませんでした。通信できているか確かめて、もう一度ためしてください");
}

// ───────── 本番：Amazon Cognito ─────────
let amplifyReady = false;
async function amplify() {
  const mod = await import("aws-amplify/auth");
  if (!amplifyReady) {
    const { Amplify } = await import("aws-amplify");
    Amplify.configure({
      Auth: {
        Cognito: {
          userPoolId: config.userPoolId,
          userPoolClientId: config.userPoolClientId,
          loginWith: { email: true },
        },
      },
    });
    amplifyReady = true;
  }
  return mod;
}

const cognitoAuth: Auth = {
  async currentUser() {
    const a = await amplify();
    try {
      const user = await a.getCurrentUser();
      return user.signInDetails?.loginId ?? user.username;
    } catch {
      return null;
    }
  },
  async signIn(email, password) {
    const a = await amplify();
    try {
      const { nextStep } = await a.signIn({ username: email.trim(), password });
      if (nextStep.signInStep === "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED") return "newPasswordRequired";
      if (nextStep.signInStep === "DONE") return "done";
      throw new AuthError("このログイン方法にはまだ対応していません");
    } catch (e) {
      if (e instanceof AuthError) throw e;
      throw friendlyAuthError(e);
    }
  },
  async completeNewPassword(newPassword) {
    const a = await amplify();
    try {
      await a.confirmSignIn({ challengeResponse: newPassword });
    } catch (e) {
      throw friendlyAuthError(e);
    }
  },
  async requestPasswordReset(email) {
    const a = await amplify();
    try {
      await a.resetPassword({ username: email.trim() });
    } catch (e) {
      throw friendlyAuthError(e);
    }
  },
  async confirmPasswordReset(email, code, newPassword) {
    const a = await amplify();
    try {
      await a.confirmResetPassword({ username: email.trim(), confirmationCode: code.trim(), newPassword });
    } catch (e) {
      throw friendlyAuthError(e);
    }
  },
  async signOut() {
    const a = await amplify();
    await a.signOut();
  },
  async accessToken() {
    const a = await amplify();
    const session = await a.fetchAuthSession();
    return session.tokens?.accessToken?.toString() ?? null;
  },
};

// ───────── お試しモード ─────────
// パスワードは何でもOK。「new」から始まるメールだと、初めてのログイン（新しいパスワードを決める）を試せる
const MOCK_KEY = "shinkoku-mock-user";
const mockStore = {
  get: () => {
    try {
      return sessionStorage.getItem(MOCK_KEY);
    } catch {
      return null;
    }
  },
  set: (v: string | null) => {
    try {
      if (v) sessionStorage.setItem(MOCK_KEY, v);
      else sessionStorage.removeItem(MOCK_KEY);
    } catch {
      /* 保存できなくても動く */
    }
  },
};
let mockPending: string | null = null;

const mockAuth: Auth = {
  async currentUser() {
    return mockStore.get();
  },
  async signIn(email, password) {
    if (!email.includes("@") || !password) throw new AuthError("メールアドレスかパスワードがちがいます");
    if (email.startsWith("new")) {
      mockPending = email;
      return "newPasswordRequired";
    }
    mockStore.set(email);
    return "done";
  },
  async completeNewPassword(newPassword) {
    if (newPassword.length < 12) throw new AuthError("パスワードは12文字以上で、英大文字・英小文字・数字をまぜてください");
    mockStore.set(mockPending);
  },
  async requestPasswordReset() {},
  async confirmPasswordReset(_email, code) {
    if (code !== "123456") throw new AuthError("確認コードがちがいます");
  },
  async signOut() {
    mockStore.set(null);
  },
  async accessToken() {
    return mockStore.get() ? "mock-token" : null;
  },
};

export const auth: Auth = config.mock ? mockAuth : cognitoAuth;
