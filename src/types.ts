export interface I18n {
  'zh-CN': string;
  en: string;
  [key: string]: string;
}

export interface Coord {
  x: number;
  y: number;
  z: number;
}

export interface Builder {
  name: string;
  uuid: string;
  weight: number;
}

export interface Source {
  originalAuthor?: string;
  originalLink?: string;
  notes?: I18n;
}

export interface Building {
  id: string;
  name: I18n;
  description: I18n;
  coordinates: Coord;
  builders: Builder[];
  buildType: 'original' | 'derivative' | 'replica';
  images: string[];
  buildDate: string;
  tags?: I18n[];
  source?: Source | null;
  createdAt: string;
  updatedAt: string;
}

export type BuildingInput = Omit<Building, 'id' | 'createdAt' | 'updatedAt'>;

export interface BuildingSubmissionImage {
  url: string;
  width: number;
  height: number;
  size: number;
  mime: string;
}

export interface BuildingSubmission {
  id: string;
  status: 'pending' | 'approved' | 'rejected';
  submitterUuid: string;
  submitterName: string;
  submitterRole: string;
  payload: BuildingInput;
  images: BuildingSubmissionImage[];
  reviewer?: string;
  reviewNote?: string;
  buildingId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdminActor {
  email?: string;
  subject?: string;
}
