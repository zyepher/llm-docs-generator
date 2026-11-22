export const ROOM_IDS = ['atrium', 'boardroom', 'studio'] as const;

export type RoomId = (typeof ROOM_IDS)[number];
