import { DEFAULT_PROFILE } from './profiles';

// Biến global lưu trạng thái cấu hình hiện tại, tách ngoài React tree
// để các API Services thuần Typescript có thể đọc đồng bộ mà không cần hook.
let activeProfileId = DEFAULT_PROFILE;

export const getActiveProfileId = () => {
    return activeProfileId;
};

export const setActiveProfileId = (profileId: string) => {
    console.log(`[Profile Config] Đã chuyển đổi System Profile sang: ${profileId}`);
    activeProfileId = profileId;
};
