import { IsOptional, IsString } from 'class-validator';

export class CancelOrderRequestDto {
  @IsOptional()
  @IsString()
  note?: string;
}
