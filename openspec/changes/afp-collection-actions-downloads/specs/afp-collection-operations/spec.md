## ADDED Requirements

### Requirement: Select images across favorite collections
The workbench SHALL let the user select and deselect images by clicking their cards and SHALL preserve the selection and each selected image's source collection while the user changes collections.

#### Scenario: Toggle a photo selection
- **WHEN** the user clicks an image card
- **THEN** the image is added to or removed from the selection and a visible SVG selection marker reflects the state

#### Scenario: Open details with the pointer
- **WHEN** the user right-clicks an image card
- **THEN** the workbench suppresses the browser context menu and opens that image's details

#### Scenario: Toggle selection with the keyboard
- **WHEN** the user activates the focused photo selection button
- **THEN** the pressed state and SVG check update without opening details or executing the parent click a second time

### Requirement: Present complete images and a compact selection summary
Gallery cards SHALL use equal preview heights across loading, decoded and error states, while images retain their original proportions without cropping. The selection summary SHALL combine up to three complete thumbnails, overflow and a count Tag in one project Button that toggles the selection drawer and exposes its expanded state.

#### Scenario: Display landscape and portrait previews
- **WHEN** a gallery image finishes decoding
- **THEN** its frame keeps the shared gallery preview height and the complete image is visible with necessary letterboxing

#### Scenario: Open a selection containing more than three images
- **WHEN** the user activates the selection summary
- **THEN** the drawer opens without changing selections and the summary shows three thumbnails, the overflow amount and the total count

#### Scenario: Preserve source collections
- **WHEN** the user selects an image in a favorite collection and then switches collections
- **THEN** the selected image and its source collection remain available to batch actions

### Requirement: Browse and collapse favorite collections
The workbench SHALL show searchable favorite collections with their names, access labels and image counts, SHALL omit the unarchived collection, and SHALL allow the sidebar to collapse to release gallery width.

#### Scenario: Filter collections
- **WHEN** the user enters a query in the collection search field
- **THEN** only matching favorite collections remain visible

#### Scenario: Collapse the sidebar
- **WHEN** the user activates the collapse control
- **THEN** the collection list is hidden and the gallery uses the released width

### Requirement: Perform safe batch collection operations
The workbench SHALL provide batch controls for downloading selected images, unlinking them from their source favorites, and copying or moving them to another writable favorite. Unlinking SHALL remove only favorite membership and SHALL never delete the AFP photo or entire favorite. A move SHALL add and verify the target membership before removing source memberships. Read-only or unknown sources SHALL block unlink and move actions.

#### Scenario: Remove images from favorites
- **WHEN** the user confirms removal for selected images with writable, known sources
- **THEN** the Host removes only those image relationships using the single-document unlink operation and reports per-image outcomes

#### Scenario: Reject unsafe source removal
- **WHEN** any selected image has an unknown, shared or read-only source
- **THEN** unlink and move actions are unavailable for that selection

#### Scenario: Copy to another favorite
- **WHEN** the user confirms a copy to a writable target favorite
- **THEN** the Host adds each selected image to the target and leaves its source memberships unchanged

#### Scenario: Move to another favorite
- **WHEN** the user confirms a move to a writable target favorite
- **THEN** the Host adds each image to the target, verifies target membership, then removes it from writable sources and reports partial failures

### Requirement: Keep selection drawer controls compact and accessible
The selection drawer SHALL omit its header close button, SHALL close through the selection summary toggle, and SHALL reveal row removal controls on hover or keyboard focus. Touch devices SHALL keep row removal controls visible. Closing the drawer SHALL preserve selections; removing a row SHALL remove only that selected photo.

#### Scenario: Close without clearing selections
- **WHEN** the user activates the selection summary toggle while the drawer is open
- **THEN** the drawer closes and all selected photos remain selected

#### Scenario: Remove one selected photo
- **WHEN** the user hovers, focuses or touches a row removal control and activates it
- **THEN** only that row is removed from the local selection and other selections remain

### Requirement: Keep photo action markers and tooltips compact
Photo selection SHALL use a small circular check inside the existing accessible project Button. Photo action tooltips SHALL use concise localized operation text and a width cap, while accessible button names SHALL retain the complete photo title.

#### Scenario: Hover an action on a long-titled photo
- **WHEN** the user hovers the selection or removal action on a photo with a long title
- **THEN** the tooltip shows only the operation label without expanding to include the title
