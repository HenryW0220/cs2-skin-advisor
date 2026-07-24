import { NextRequest, NextResponse } from "next/server";

// 部署到公网（Oracle Cloud）之后加的最低限度保护：这个项目是单用户设计，没有登录体系，
// 一旦有公网IP，任何人拿到地址就能看到持仓/策略/交易记录。本机开发不受影响——
// 没配 BASIC_AUTH_USER/PASSWORD 时（.env.development 就没配）直接放行，不锁自己。
export function middleware(request: NextRequest) {
  const user = process.env.BASIC_AUTH_USER;
  const password = process.env.BASIC_AUTH_PASSWORD;
  if (!user || !password) return NextResponse.next();

  const auth = request.headers.get("authorization");
  if (auth) {
    const [scheme, encoded] = auth.split(" ");
    if (scheme === "Basic" && encoded) {
      const [reqUser, reqPassword] = Buffer.from(encoded, "base64").toString().split(":");
      if (reqUser === user && reqPassword === password) {
        return NextResponse.next();
      }
    }
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="cs2-skin-advisor"' },
  });
}

export const config = {
  matcher: "/((?!_next/static|_next/image|favicon.ico|sw.js).*)",
};
