import { Type } from 'class-transformer';
import { ArrayMinSize, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Min, ValidateNested } from 'class-validator';

export class PlaceOrderLineDto {
  @IsString()
  @IsNotEmpty()
  productCode!: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsOptional()
  @IsInt()
  unitPrice?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  lineDiscount?: number;
}

export class PlaceOrderRequestDto {
  @IsString()
  @IsNotEmpty()
  retailerCode!: string;

  @IsString()
  @IsNotEmpty()
  companyCode!: string;

  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @ValidateNested({ each: true })
  @Type(() => PlaceOrderLineDto)
  @ArrayMinSize(1)
  lines!: PlaceOrderLineDto[];

  @IsOptional()
  @IsInt()
  orderDiscount?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}
