import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsNotEmpty, IsString, Matches, ValidateNested } from 'class-validator';

export class MoneyDto {
  @IsInt()
  amount!: number;

  @Matches(/^[A-Z]{3}$/)
  currency!: string;
}

export class RegisterPaymentRequestDto {
  @IsString()
  @IsNotEmpty()
  paymentReference!: string;

  @ValidateNested()
  @Type(() => MoneyDto)
  amount!: MoneyDto;

  @IsISO8601()
  valueDate!: string;

  @IsIn(['operator', 'robot', 'test'])
  source!: 'operator' | 'robot' | 'test';
}
