import exifr from "exifr";

export type PhotoMetadata = {
  hasDate: boolean;
  hasGps: boolean;
  dateTimeOriginal: Date | null;
  latitude: number | null;
  longitude: number | null;
  /** EXIF가 단순히 없는 것과 구분되는, 실제 파싱 중 발생한 에러 메시지 */
  error: string | null;
};

const EMPTY: Omit<PhotoMetadata, "error"> = {
  hasDate: false,
  hasGps: false,
  dateTimeOriginal: null,
  latitude: null,
  longitude: null,
};

/**
 * 파일에서 EXIF 메타데이터(촬영 날짜, GPS)를 추출한다.
 * EXIF가 없는 정상적인 경우와, 파싱 자체가 실패한 경우(error 필드)를 구분해서 반환한다.
 * 이 함수 자체는 절대 throw하지 않는다 — 항상 PhotoMetadata를 resolve한다.
 */
export async function extractPhotoMetadata(
  file: File
): Promise<PhotoMetadata> {
  try {
    const output = await exifr.parse(file, {
      tiff: true,
      exif: true,
      gps: true,
      translateValues: true,
      reviveValues: true,
    });

    if (!output) return { ...EMPTY, error: null };

    const date: Date | undefined =
      output.DateTimeOriginal ?? output.CreateDate ?? output.ModifyDate;

    const latitude: number | undefined = output.latitude;
    const longitude: number | undefined = output.longitude;

    return {
      hasDate: date instanceof Date && !Number.isNaN(date.getTime()),
      hasGps: typeof latitude === "number" && typeof longitude === "number",
      dateTimeOriginal: date instanceof Date ? date : null,
      latitude: typeof latitude === "number" ? latitude : null,
      longitude: typeof longitude === "number" ? longitude : null,
      error: null,
    };
  } catch (err) {
    // 손상되었거나 exifr이 지원하지 못하는 형식 - 에러를 기록하고 반환 (throw하지 않음)
    return {
      ...EMPTY,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * extractPhotoMetadata를 타임아웃과 함께 실행한다.
 * 일부 HEIC 파일에서 exifr이 응답 없이 멈추는(hang) 사례가 있어,
 * 한 파일이 영원히 끝나지 않아도 다른 파일 처리를 막지 않도록 방어한다.
 */
export async function extractPhotoMetadataSafe(
  file: File,
  timeoutMs = 8000
): Promise<PhotoMetadata> {
  return Promise.race([
    extractPhotoMetadata(file),
    new Promise<PhotoMetadata>((resolve) => {
      setTimeout(() => {
        resolve({
          ...EMPTY,
          error: `타임아웃 (${timeoutMs}ms 내에 처리되지 않음)`,
        });
      }, timeoutMs);
    }),
  ]);
}
