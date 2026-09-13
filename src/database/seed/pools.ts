/** Shared name/id pools for the general dataset generator — kept separate so general-dataset.ts stays readable. */

export const PRODUCT_TEMPLATES: { name: string; category: string }[] = [
  { name: 'Wireless Bluetooth Headphones', category: 'Electronics' },
  { name: 'USB-C Fast Charger 65W', category: 'Electronics' },
  { name: 'Mechanical Keyboard', category: 'Electronics' },
  { name: 'Wireless Mouse', category: 'Electronics' },
  { name: 'Portable Power Bank 20000mAh', category: 'Electronics' },
  { name: 'HD Webcam', category: 'Electronics' },
  { name: 'Bluetooth Speaker', category: 'Electronics' },
  { name: 'Smart Watch', category: 'Electronics' },
  { name: 'Cotton T-Shirt', category: 'Apparel' },
  { name: 'Denim Jeans', category: 'Apparel' },
  { name: 'Running Shoes', category: 'Apparel' },
  { name: 'Winter Jacket', category: 'Apparel' },
  { name: 'Wool Socks Pack', category: 'Apparel' },
  { name: 'Baseball Cap', category: 'Apparel' },
  { name: 'Non-Stick Frying Pan', category: 'Home & Kitchen' },
  { name: 'Ceramic Dinner Set', category: 'Home & Kitchen' },
  { name: 'Electric Kettle', category: 'Home & Kitchen' },
  { name: 'Vacuum Flask', category: 'Home & Kitchen' },
  { name: 'LED Desk Lamp', category: 'Home & Kitchen' },
  { name: 'Cotton Bedsheet Set', category: 'Home & Kitchen' },
  { name: 'Yoga Mat', category: 'Sports & Fitness' },
  { name: 'Adjustable Dumbbell Set', category: 'Sports & Fitness' },
  { name: 'Resistance Bands Set', category: 'Sports & Fitness' },
  { name: 'Cycling Helmet', category: 'Sports & Fitness' },
  { name: 'Water Bottle 1L', category: 'Sports & Fitness' },
  { name: 'Notebook Set A5', category: 'Stationery' },
  { name: 'Gel Pen Pack', category: 'Stationery' },
  { name: 'Desk Organizer', category: 'Stationery' },
  { name: 'Whiteboard Marker Set', category: 'Stationery' },
  { name: 'Skin Care Gift Set', category: 'Beauty & Personal Care' },
  { name: 'Electric Toothbrush', category: 'Beauty & Personal Care' },
  { name: 'Hair Dryer', category: 'Beauty & Personal Care' },
  { name: 'Board Game Classic Set', category: 'Toys & Games' },
  { name: 'Building Blocks Set', category: 'Toys & Games' },
  { name: 'Remote Control Car', category: 'Toys & Games' },
];

export const PACKAGE_SIZES = ['20x15x10', '30x20x15', '40x30x20', '50x40x30', '25x25x25'];
export const CARRIERS = ['Ecom Express', 'Ekart', 'Delhivery', 'Bluedart', 'DTDC', 'XpressBees'];
export const CITIES = ['DL', 'MH', 'KA', 'TN', 'WB', 'GJ'];
export const RETURN_REASONS = ['PRODUCT_DAMAGED', 'WRONG_ITEM', 'SIZE_ISSUE', 'MISSING_PART', 'NOT_AS_DESCRIBED', 'CHANGED_MIND', 'QUALITY_ISSUE'];
export const ZONES = ['A', 'B', 'C', 'D', 'E', 'F'];

export function locationCode(rng: { int(a: number, b: number): number }): string {
  const zone = ZONES[rng.int(0, ZONES.length - 1)];
  return `${zone}-${String(rng.int(1, 12)).padStart(2, '0')}-${String(rng.int(1, 20)).padStart(2, '0')}`;
}

export function dockCode(rng: { int(a: number, b: number): number }): string {
  return `DOCK-${String(rng.int(1, 8)).padStart(2, '0')}`;
}

export function truckCode(rng: { int(a: number, b: number): number }, pick: <T>(a: readonly T[]) => T): string {
  return `TRUCK-${pick(CITIES)}-${String(rng.int(1, 60)).padStart(2, '0')}`;
}
