/**
 * 누끼를 같은 Storage 경로(users/{uid}/looks/{lookId}/cutout(-thumb))에
 * 덮어쓰기 때문에, 재생성해도 download URL 문자열 자체는 토큰까지 완전히
 * 똑같을 수 있다 - 그러면 브라우저/중간 캐시가 "이 URL은 이미 받아봤다"며
 * 예전 이미지를 그대로 재사용해 버릴 수 있다. Firebase download URL의
 * 기존 쿼리(alt=media&token=...)는 그대로 둔 채 버전 쿼리만 하나 덧붙여서,
 * URL 구조/토큰은 전혀 건드리지 않고 매 재생성마다 다른 URL로 보이게 한다.
 */
export function withCacheBust(url: string | null, versionMs: number | null): string | null {
  if (!url || !versionMs) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}v=${versionMs}`;
}
