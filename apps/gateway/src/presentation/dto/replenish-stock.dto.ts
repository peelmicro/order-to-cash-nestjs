import { Type } from 'class-transformer';
import { ArrayMinSize, IsInt, IsNotEmpty, IsString, Min, ValidateNested } from 'class-validator';

export class ReplenishStockLineDto {
  @IsString()
  @IsNotEmpty()
  productCode!: string;

  @IsInt()
  @Min(1)
  units!: number;
}

export class ReplenishStockRequestDto {
  @IsString()
  @IsNotEmpty()
  companyCode!: string;

  @ValidateNested({ each: true })
  @Type(() => ReplenishStockLineDto)
  @ArrayMinSize(1)
  lines!: ReplenishStockLineDto[];
}
