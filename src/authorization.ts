import type { AuthProps } from "./env";

export function validAuthProps(value: unknown): value is AuthProps {
  if (!value || typeof value !== "object") return false;
  const props = value as Partial<AuthProps>;
  return (
    typeof props.email === "string" &&
    props.email.length > 0 &&
    typeof props.subject === "string" &&
    props.subject.length > 0 &&
    Array.isArray(props.permissions) &&
    props.permissions.length === 1 &&
    props.permissions[0] === "toolbox" &&
    typeof props.authenticatedAt === "number" &&
    Number.isFinite(props.authenticatedAt) &&
    typeof props.loginExpiresAt === "number" &&
    Number.isFinite(props.loginExpiresAt) &&
    props.authenticatedAt <= Date.now() &&
    props.loginExpiresAt > props.authenticatedAt &&
    props.loginExpiresAt <= props.authenticatedAt + 7 * 24 * 60 * 60 * 1000
  );
}
