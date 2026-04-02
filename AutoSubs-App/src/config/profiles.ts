export interface IVideoProfile {
  id: string;
  name: string;
  description: string;
  // Các cờ cấu hình (Flags) sẽ thêm dần ở đây
}

export const profiles: Record<string, IVideoProfile> = {
  documentary: {
    id: 'documentary',
    name: 'Phim Tài Liệu (Ký Sự)',
    description: 'Dạng video ngang, nhịp chậm, tập trung nội dung chi tiết dạng phim ký sự.',
  },
  // tiktok_shorts: {
  //   id: 'tiktok_shorts',
  //   name: 'Tiktok / Shorts',
  //   description: 'Dạng video dọc, nhịp nhanh, cần hiệu ứng âm thanh dày và cắt ghép khung mặt tĩnh.',
  // },
};

export const DEFAULT_PROFILE = 'documentary';
