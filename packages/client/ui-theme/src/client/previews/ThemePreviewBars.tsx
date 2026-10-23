/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
/** Shared chart geometry for the light and dark Appearance previews.
 * @returns The unchanged chart rectangles, inheriting the preview's fill.
 */
export function ThemePreviewBars() {
  return <>
    <rect
      x={33.36}
      y={19.73}
      width={2.75}
      height={3.42}
      rx={0.33}
      ry={0.33}
      opacity={0.32}
    />
    <rect
      x={29.64}
      y={16.57}
      width={2.75}
      height={6.58}
      rx={0.33}
      ry={0.33}
      opacity={0.44}
    />
    <rect
      x={37.16}
      y={14.44}
      width={2.75}
      height={8.7}
      rx={0.33}
      ry={0.33}
      opacity={0.53}
    />
    <rect
      x={41.19}
      y={10.75}
      width={2.75}
      height={12.4}
      rx={0.33}
      ry={0.33}
      opacity={0.53}
    />
  </>
}
