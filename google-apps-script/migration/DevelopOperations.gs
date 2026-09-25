/** Install the approved project mapping after its physical folders are moved. */
function configureProjectMounts() {
  var ss=sandboxGuard_(),p=PropertiesService.getScriptProperties();
  var config=JSON.parse(DriveApp.getFileById('13pcmqFeD_RvtI9Wi-8hm9GxuNjRiNEro').getBlob().getDataAsString('UTF-8'));
  if(config.develop_sheet_id!==ss.getId()||config.root_id!=='1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH'||config.mount_config.mounts.length!==24)throw new Error('Unexpected project mapping');
  config.mount_config.mounts.forEach(function(m){var folder=DriveApp.getFolderById(m.id),project=oneParent_(folder);if(project.getId()!==m.project_id||oneParent_(project).getId()!==config.root_id)throw new Error('Project mount is not in position: '+m.logical_path);});
  p.setProperty('AIS_PROJECT_MOUNTS_V1',JSON.stringify(config.mount_config));
  var snapshot=checkedSnapshot_('',true);
  audit_(ss,'project-folders-migrated',snapshot.manifest.registry_revision,'24 source mounts in AISInstrumentationGym; file IDs and logical routes preserved');
  console.log('All '+snapshot.files.length+' sources verified in the original project folders; existing snapshot remains valid.');
}
